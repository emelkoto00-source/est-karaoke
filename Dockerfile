FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    ca-certificates \
    python3 \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Dedicated Python environment for neural vocal separation.
RUN python3 -m venv /opt/demucs
ENV DEMUCS_PYTHON=/opt/demucs/bin/python \
    DEMUCS_MODEL=htdemucs \
    DEMUCS_DEVICE=cpu \
    DEMUCS_SEGMENT=7 \
    VIDEO_SYNC_SAMPLE_FPS=4 \
    VIDEO_SYNC_MAX_SECONDS=180 \
    YOUTUBE_MAX_DURATION_SECONDS=900 \
    VIDEO_UPLOAD_MAX_DURATION_SECONDS=1200 \
    TORCH_HOME=/opt/demucs-models \
    PYTHONUNBUFFERED=1 \
    OMP_NUM_THREADS=1 \
    MKL_NUM_THREADS=1 \
    OPENBLAS_NUM_THREADS=1 \
    NUMEXPR_NUM_THREADS=1

COPY requirements-separation.txt /tmp/requirements-separation.txt

# Install CPU-only PyTorch first so Railway does not pull CUDA runtime packages.
RUN /opt/demucs/bin/pip install --no-cache-dir --upgrade pip setuptools wheel \
    && /opt/demucs/bin/pip install --no-cache-dir \
       --index-url https://download.pytorch.org/whl/cpu \
       torch==2.2.2 torchaudio==2.2.2 \
    && /opt/demucs/bin/pip install --no-cache-dir -r /tmp/requirements-separation.txt

# Pre-download the model during BUILD. This intentionally makes the deployment
# fail at build time if the model cannot be obtained, rather than accepting an
# Original Audio upload later and failing unexpectedly at runtime.
RUN mkdir -p "${TORCH_HOME}" \
    && /opt/demucs/bin/python -c \
       "from demucs.pretrained import get_model; m=get_model('htdemucs'); print('Baked Demucs model:', type(m).__name__)"

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm","start"]
