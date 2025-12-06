#!/bin/sh
set -e

# Generate htpasswd file from environment variables
if [ -n "$AUTH_USER" ] && [ -n "$AUTH_PASSWORD" ]; then
    echo "Generating .htpasswd file..."
    htpasswd -bc /etc/nginx/.htpasswd "$AUTH_USER" "$AUTH_PASSWORD"
else
    echo "WARNING: AUTH_USER or AUTH_PASSWORD not set. Using default credentials (admin/admin)"
    htpasswd -bc /etc/nginx/.htpasswd "admin" "admin"
fi

# Execute the CMD
exec "$@"
