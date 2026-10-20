#!/usr/bin/env python3
"""Read-only checks for a public Cloud Run deployment; no users or content are created."""

import argparse

import httpx


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url")
    args = parser.parse_args()
    base = args.url.rstrip("/")
    with httpx.Client(base_url=base, timeout=30) as client:
        response = client.get("/health")
        assert response.status_code == 200 and response.json() == {"status": "ok"}, "Mongo health failed"
        print("PASS /health: API and Mongo reachable")
        for path in ("/api/posts", "/api/profile", "/api/admin/members"):
            assert client.get(path).status_code == 401, f"Unauthenticated access unexpectedly allowed: {path}"
        print("PASS protected routes reject unauthenticated requests")
        assert client.get("/api/posts", headers={"Authorization": "Bearer invalid"}).status_code == 401
        print("PASS invalid app JWT rejected")
        response = client.post("/api/auth/session", json={"provider": "supabase", "access_token": "invalid"})
        assert response.status_code == 401, f"Supabase exchange misconfigured: HTTP {response.status_code}"
        print("PASS external identity exchange rejects invalid Supabase tokens")
        response = client.options(
            "/api/posts",
            headers={
                "Origin": "https://helenakapeach.github.io",
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "authorization",
            },
        )
        assert response.status_code == 200
        assert response.headers.get("access-control-allow-origin") == "https://helenakapeach.github.io"
        print("PASS frontend origin CORS configured")
        spec = client.get("/openapi.json")
        spec.raise_for_status()
        assert "/api/posts" in spec.json()["paths"]
        print("PASS OpenAPI schema available")


if __name__ == "__main__":
    main()
