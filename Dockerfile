FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglu1-mesa libglib2.0-0 libx11-6 libxrender1 libxext6 libsm6 libxmu6 libxi6 libexpat1 fontconfig \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml requirements.lock README.md LICENSE ./
COPY src/ ./src/

RUN python -m pip install --no-cache-dir -r requirements.lock \
    && python -m pip install --no-cache-dir --no-deps .

ENTRYPOINT ["chamfer-mcp", "--port", "0"]
