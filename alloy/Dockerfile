FROM grafana/alloy:v1.17.0
COPY config.alloy /etc/alloy/config.alloy
# Cloud Run sets $PORT; Alloy must bind it so the instance passes health checks.
ENTRYPOINT ["/bin/sh", "-c", "exec /bin/alloy run --server.http.listen-addr=0.0.0.0:${PORT:-8080} /etc/alloy/config.alloy"]
