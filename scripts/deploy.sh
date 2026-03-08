#!/bin/bash
set -e

echo "=== GrantRadar Deploy ==="
echo "Deploying to Railway..."

# Check if railway CLI is available
if ! command -v railway &> /dev/null; then
    echo "Railway CLI not found. Install with: npm i -g @railway/cli"
    exit 1
fi

# Deploy
railway up --detach

echo "Deploy triggered successfully!"
echo "Check status: railway logs"
