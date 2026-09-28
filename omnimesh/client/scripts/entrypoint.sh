#!/bin/sh
set -eu

MODEL_PATH="/models/${MODEL_FILE:-model.gguf}"

if [ ! -f "$MODEL_PATH" ]; then
    echo "Model not found: $MODEL_PATH (mount it into /models and set MODEL_FILE)" >&2
    exit 1
fi

exec llama-server \
    --model "$MODEL_PATH" \
    --host 0.0.0.0 \
    --port 8080 \
    --ctx-size "${LLAMA_CTX_SIZE:-2048}" \
    --threads "${LLAMA_THREADS:-4}"
