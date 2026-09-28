FROM debian:trixie-slim AS fetch

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Prebuilt release binary instead of compiling from source - keep this
# tag in sync with omnimesh/client/scripts/install.sh's LLAMA_RELEASE_TAG
# (same pinning rationale: llama.cpp ships many non-semver builds a day,
# bump deliberately after testing). CPU-only build, matching this base
# image (no CUDA toolkit in debian:trixie-slim) - GPU support here would
# need a CUDA base image plus GPU passthrough in docker-compose.yml.
ARG LLAMA_RELEASE_TAG=b11232
RUN curl -sSL -o /tmp/llama.tar.gz \
    "https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_RELEASE_TAG}/llama-${LLAMA_RELEASE_TAG}-bin-ubuntu-x64.tar.gz" \
    && mkdir -p /out \
    && tar -xzf /tmp/llama.tar.gz -C /out --strip-components=1 \
    && rm /tmp/llama.tar.gz

FROM debian:trixie-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=fetch /out/ /usr/local/lib/llama.cpp/
RUN ln -s /usr/local/lib/llama.cpp/llama-server /usr/local/bin/llama-server \
    && echo /usr/local/lib/llama.cpp > /etc/ld.so.conf.d/llama.conf \
    && ldconfig

WORKDIR /models
EXPOSE 8080

COPY scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
