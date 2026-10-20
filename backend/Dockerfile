FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/backend/.venv \
    PORT=8080 \
    PATH="/backend/.venv/bin:$PATH"

WORKDIR /backend
RUN pip install --no-cache-dir uv==0.9.22
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project --extra migration
COPY app ./app
RUN useradd --create-home --shell /usr/sbin/nologin appuser \
    && chown -R appuser:appuser /backend
USER appuser
EXPOSE 8080
CMD ["sh", "-c", "exec python -m uvicorn app.main:create_app --factory --workers 1 --host 0.0.0.0 --port \"${PORT:-8080}\""]
