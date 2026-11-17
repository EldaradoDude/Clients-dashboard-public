# The viewer, and (with another command) the demo data generator. See demo/compose.yaml.
# Build from the project root: docker build -f demo/Dockerfile .
# BuildKit reads demo/Dockerfile.dockerignore as this build's ignore file.
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
RUN useradd --create-home viewer && mkdir /data && chown viewer /data
USER viewer

EXPOSE 8050
CMD ["python", "-m", "uvicorn", "viewer.main:app", "--host", "0.0.0.0", "--port", "8050"]
