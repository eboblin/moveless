#!/usr/bin/env bash
# Собирает dist/moveless-module.tar.gz для Schwung Manager.
# Состав архива совпадает с scripts/deploy.ps1: папка moveless/ внутри архива.
set -euo pipefail
cd "$(dirname "$0")/.."

npm run build

if [[ "${SKIP_DSP:-}" != "1" ]]; then
  docker build -t moveless-dsp dsp
  docker run --rm -v "$PWD/dsp:/src" -v "$PWD:/out" moveless-dsp \
    bash -lc 'srcs=$(ls src/*.c | grep -v /check.c); aarch64-linux-gnu-gcc -O2 -Wall -Werror -shared -fPIC -o /out/dsp.so $srcs -lm -Wl,--version-script=src/plugin.lds'
fi

if [[ ! -f dsp.so ]]; then
  echo "нет dsp.so" >&2
  exit 1
fi

stage=dist/moveless
rm -rf "$stage"
mkdir -p "$stage"
cp module.json ui.js dsp.so "$stage/"
cp assets/font.png assets/font.png.dat assets/factory.json assets/samples/bank.json "$stage/"
mkdir -p "$stage/licenses"
cp assets/samples/NOTICE.md assets/samples/licenses/* "$stage/licenses/"
if [[ -f samples.bin ]]; then
  cp samples.bin "$stage/"
else
  echo "нет samples.bin — голос останется на синтезе. собери: npm run pack-samples" >&2
fi

rm -f dist/moveless-module.tar.gz
tar -czf dist/moveless-module.tar.gz -C dist moveless

listing=$(tar -tf dist/moveless-module.tar.gz)
for name in moveless/module.json moveless/ui.js moveless/dsp.so moveless/font.png moveless/font.png.dat moveless/factory.json moveless/bank.json moveless/licenses/NOTICE.md moveless/licenses/FluidR3.md moveless/licenses/GeneralUser-GS.txt moveless/licenses/tidal-drum-machines.md; do
  grep -qx "$name" <<<"$listing" || { echo "в архиве нет $name" >&2; exit 1; }
done

echo "архив: dist/moveless-module.tar.gz"
