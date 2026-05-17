FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      chromium \
      python3 python3-pip python3-venv \
      fonts-dejavu fontconfig \
      ca-certificates \
      curl \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /usr/local/share/fonts/clips-builtins && \
    curl -fsSL https://github.com/google/fonts/raw/main/ofl/anton/Anton-Regular.ttf -o /usr/local/share/fonts/clips-builtins/Anton-Regular.ttf && \
    curl -fsSL https://github.com/google/fonts/raw/main/ofl/blackopsone/BlackOpsOne-Regular.ttf -o /usr/local/share/fonts/clips-builtins/BlackOpsOne-Regular.ttf && \
    curl -fsSL https://github.com/google/fonts/raw/main/ofl/bebasneue/BebasNeue-Regular.ttf -o /usr/local/share/fonts/clips-builtins/BebasNeue-Regular.ttf && \
    curl -fsSL https://github.com/google/fonts/raw/main/ofl/oswald/Oswald%5Bwght%5D.ttf -o /usr/local/share/fonts/clips-builtins/Oswald[wght].ttf && \
    fc-cache -f

RUN python3 -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir faster-whisper && \
    /opt/venv/bin/python -c "from faster_whisper import WhisperModel; WhisperModel('medium.en', device='cpu', compute_type='int8')"
ENV PATH="/opt/venv/bin:${PATH}"

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY scripts ./scripts
COPY templates ./templates
COPY src ./src

RUN npm run build

ENV CHROME_BIN=/usr/bin/chromium
CMD ["node", "dist/index.js"]
