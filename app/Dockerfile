FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/app/.venv \
    PORT=8080 \
    PATH="/app/.venv/bin:$PATH"

WORKDIR /app
RUN pip install --no-cache-dir uv==0.9.22
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project --extra migration
COPY sa_backend ./sa_backend
RUN useradd --create-home --shell /usr/sbin/nologin appuser \
    && chown -R appuser:appuser /app
USER appuser
EXPOSE 8080
CMD ["sh", "-c", "exec python -m uvicorn sa_backend.main:create_app --factory --workers 1 --host 0.0.0.0 --port \"${PORT:-8080}\""]
