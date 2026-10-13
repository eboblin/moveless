FROM ubuntu:22.04

RUN apt-get update && apt-get install -y \
    gcc \
    gcc-aarch64-linux-gnu \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
