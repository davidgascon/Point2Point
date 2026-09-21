FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

# Runs unprivileged; only Caddy can reach it.
RUN useradd -m -u 10001 app && mkdir -p /templates && chown app /templates
USER app

EXPOSE 8030
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8030"]
