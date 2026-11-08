#include "engine.h"

#include <ctype.h>
#include <fcntl.h>
#include <signal.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

#define CURL_PATH "/data/UserData/schwung/bin/curl"

static const char *skip_space(const char *p) {
    while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++;
    return p;
}

static const char *field_at(const char *text, const char *key) {
    char pat[80];
    const char *p;
    int wrote = snprintf(pat, sizeof pat, "\"%s\"", key);
    if (wrote < 0 || wrote >= (int)sizeof pat) return NULL;
    p = strstr(text, pat);
    if (!p) return NULL;
    p = skip_space(p + wrote);
    if (*p != ':') return NULL;
    return skip_space(p + 1);
}

static int copy_url(const char *text, char *out, int cap) {
    const char *p = field_at(text, "url");
    int n = 0;
    if (!p || *p != '"' || cap < 9) return 0;
    p++;
    while (*p && *p != '"' && n < cap - 1) {
        if (*p <= ' ' || *p == '\\') return 0;
        out[n++] = *p++;
    }
    out[n] = 0;
    if (*p != '"') return 0;
    if (strncmp(out, "https://", 8) != 0 && strncmp(out, "http://", 7) != 0) return 0;
    return 1;
}

static int copy_bytes(const char *text, int64_t *out) {
    const char *p = field_at(text, "bytes");
    char *end = NULL;
    long long value;
    if (!p || !isdigit((unsigned char)*p)) return 0;
    value = strtoll(p, &end, 10);
    if (end == p || value <= 0) return 0;
    *out = (int64_t)value;
    return 1;
}

static int read_manifest(const char *dir, char *url, int url_cap, int64_t *bytes) {
    char path[1024];
    char body[2048];
    FILE *file;
    size_t got;
    int wrote = snprintf(path, sizeof path, "%s/bank.json", dir);
    if (wrote < 0 || wrote >= (int)sizeof path) return 0;
    file = fopen(path, "r");
    if (!file) return 0;
    got = fread(body, 1, sizeof body - 1, file);
    fclose(file);
    body[got] = 0;
    if (!copy_url(body, url, url_cap) || !copy_bytes(body, bytes)) return 0;
    return 1;
}

static int join_name(const char *dir, const char *name, char *out, int cap) {
    int wrote = snprintf(out, (size_t)cap, "%s/%s", dir, name);
    return wrote > 0 && wrote < cap;
}

static int file_size(const char *path, int64_t *out) {
    struct stat st;
    if (stat(path, &st) != 0 || !S_ISREG(st.st_mode)) return 0;
    *out = (int64_t)st.st_size;
    return 1;
}

static void accept_ready(Engine *engine) {
    engine->bank_phase = engine->samples.ready ? BANK_OK : BANK_FAIL;
    engine->bank_pid = 0;
}

static int promote(Engine *engine, const char *part, const char *dest) {
    if (rename(part, dest) != 0) return 0;
    samples_load(engine, engine->bank_dir);
    accept_ready(engine);
    return engine->bank_phase == BANK_OK;
}

static int launch_curl(Engine *engine, const char *part) {
    pid_t pid = fork();
    if (pid < 0) return 0;
    if (pid == 0) {
        int fd = open("/dev/null", O_RDWR);
        int i;
        if (fd >= 0) {
            (void)dup2(fd, STDIN_FILENO);
            (void)dup2(fd, STDOUT_FILENO);
            (void)dup2(fd, STDERR_FILENO);
            if (fd > 2) (void)close(fd);
        }
        for (i = 3; i < 256; i++) (void)close(i);
        execl(
            CURL_PATH, "curl",
            "-fsSLk", "-C", "-",
            "--connect-timeout", "15",
            "--retry", "3",
            "--retry-delay", "2",
            "--max-time", "3600",
            "-o", part,
            engine->bank_url,
            (char *)NULL);
        _exit(127);
    }
    engine->bank_pid = (int)pid;
    engine->bank_phase = BANK_LOAD;
    engine->bank_pct = 0;
    return 1;
}

void samples_stop(Engine *engine) {
    if (!engine || engine->bank_pid <= 0) return;
    kill(engine->bank_pid, SIGTERM);
    waitpid((pid_t)engine->bank_pid, NULL, 0);
    engine->bank_pid = 0;
}

void samples_boot(Engine *engine, const char *module_dir) {
    char dest[1024];
    char part[1024];
    int64_t have = 0;
    int64_t part_have = 0;
    int wrote;
    if (!engine) return;
    engine->bank_phase = BANK_OFF;
    engine->bank_pid = 0;
    engine->bank_bytes = 0;
    engine->bank_pct = 0;
    engine->bank_url[0] = 0;
    engine->bank_dir[0] = 0;
    if (!module_dir || !module_dir[0]) return;
    wrote = snprintf(engine->bank_dir, sizeof engine->bank_dir, "%s", module_dir);
    if (wrote < 0 || wrote >= (int)sizeof engine->bank_dir) {
        engine->bank_dir[0] = 0;
        return;
    }
    if (!read_manifest(engine->bank_dir, engine->bank_url, (int)sizeof engine->bank_url, &engine->bank_bytes)) {
        samples_load(engine, engine->bank_dir);
        engine->bank_phase = engine->samples.ready ? BANK_OK : BANK_OFF;
        return;
    }
    if (!join_name(engine->bank_dir, "samples.bin", dest, (int)sizeof dest) ||
        !join_name(engine->bank_dir, "samples.bin.part", part, (int)sizeof part)) {
        engine->bank_phase = BANK_FAIL;
        return;
    }
    if (file_size(dest, &have) && have == engine->bank_bytes) {
        samples_load(engine, engine->bank_dir);
        if (engine->samples.ready) {
            engine->bank_phase = BANK_OK;
            return;
        }
    }
    if (file_size(part, &part_have) && part_have == engine->bank_bytes) {
        if (promote(engine, part, dest)) return;
    } else if (part_have > engine->bank_bytes) {
        (void)unlink(part);
    }
    if (!launch_curl(engine, part)) engine->bank_phase = BANK_FAIL;
}

void samples_pump(Engine *engine) {
    char dest[1024];
    char part[1024];
    int64_t got = 0;
    int status = 0;
    pid_t done;
    if (!engine || engine->bank_phase != BANK_LOAD || engine->bank_pid <= 0) return;
    if (!join_name(engine->bank_dir, "samples.bin", dest, (int)sizeof dest) ||
        !join_name(engine->bank_dir, "samples.bin.part", part, (int)sizeof part)) {
        samples_stop(engine);
        engine->bank_phase = BANK_FAIL;
        return;
    }
    if (file_size(part, &got) && engine->bank_bytes > 0 && got > 0) {
        int pct = got >= engine->bank_bytes ? 99 : (int)((got * 100) / engine->bank_bytes);
        if (pct < 0) pct = 0;
        if (pct > 99) pct = 99;
        engine->bank_pct = pct;
    }
    done = waitpid((pid_t)engine->bank_pid, &status, WNOHANG);
    if (done == 0) return;
    engine->bank_pid = 0;
    if (done > 0 && WIFEXITED(status) && WEXITSTATUS(status) == 0 &&
        file_size(part, &got) && got == engine->bank_bytes &&
        promote(engine, part, dest)) return;
    /* A finished curl that still has the wrong size is not a resume point. A dropped connection leaves the part for the next boot. */
    if (done > 0 && WIFEXITED(status) && WEXITSTATUS(status) == 0) (void)unlink(part);
    engine->bank_phase = BANK_FAIL;
    engine->bank_pct = 0;
}

int samples_bank_text(Engine *engine, char *buf, int buf_len) {
    int pct;
    if (!engine || !buf || buf_len < 5) return -1;
    samples_pump(engine);
    if (engine->bank_phase == BANK_OK) {
        memcpy(buf, "ok", 3);
        return 2;
    }
    if (engine->bank_phase == BANK_FAIL) {
        memcpy(buf, "fail", 5);
        return 4;
    }
    if (engine->bank_phase == BANK_LOAD) {
        pct = engine->bank_pct;
        if (pct < 0) pct = 0;
        if (pct > 100) pct = 100;
        buf[0] = (char)('0' + pct / 100);
        buf[1] = (char)('0' + (pct / 10) % 10);
        buf[2] = (char)('0' + pct % 10);
        buf[3] = 0;
        return 3;
    }
    memcpy(buf, "off", 4);
    return 3;
}
