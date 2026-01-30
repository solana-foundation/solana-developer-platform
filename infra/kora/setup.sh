#!/bin/bash
# Setup script for Kora local development
# Generates a new keypair and funds it with devnet SOL

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
KEYPAIR_FILE="$SCRIPT_DIR/.keypair.json"

echo "🔧 Setting up Kora for local development..."

# Check if solana CLI is installed
if ! command -v solana &> /dev/null; then
    echo "❌ Solana CLI not found. Install it from https://docs.solana.com/cli/install-solana-cli-tools"
    exit 1
fi

# Generate new keypair if .env doesn't exist
if [ -f "$ENV_FILE" ]; then
    echo "⚠️  .env already exists. Delete it to regenerate keypair."
    source "$ENV_FILE"
else
    echo "🔑 Generating new keypair..."
    solana-keygen new --no-bip39-passphrase -o "$KEYPAIR_FILE" --force

    # Extract base58 private key
    PRIVATE_KEY=$(cat "$KEYPAIR_FILE" | tr -d '[]' | tr ',' ' ' | xargs -n1 printf '%02x' | xxd -r -p | base58)

    # Get public key
    PUBLIC_KEY=$(solana-keygen pubkey "$KEYPAIR_FILE")

    echo "📝 Creating .env file..."
    cat > "$ENV_FILE" << EOF
# Kora Environment Variables (auto-generated)
# Fee payer address: $PUBLIC_KEY

RPC_URL=https://api.devnet.solana.com
SIGNER_PRIVATE_KEY=$PRIVATE_KEY
EOF

    echo "✅ Keypair generated!"
    echo "   Address: $PUBLIC_KEY"

    # Clean up JSON keypair file
    rm -f "$KEYPAIR_FILE"
fi

# Get the public key from the private key for airdrop
echo ""
echo "💰 Requesting devnet SOL airdrop..."

# Source the env to get the private key
source "$ENV_FILE"

# We need to recreate the keypair file temporarily for airdrop
# Convert base58 private key back to JSON format for solana CLI
echo "   (Creating temporary keypair file for airdrop...)"

# Use node to convert base58 to JSON keypair format
node -e "
const bs58 = require('bs58') || require('@solana/web3.js').bs58;
try {
  const key = bs58.decode('$SIGNER_PRIVATE_KEY');
  console.log(JSON.stringify(Array.from(key)));
} catch(e) {
  // Fallback: assume it's already an array
  console.log('$SIGNER_PRIVATE_KEY');
}
" > "$KEYPAIR_FILE" 2>/dev/null || {
    echo "⚠️  Could not convert keypair for airdrop. Please airdrop manually:"
    echo "   solana airdrop 2 <YOUR_ADDRESS> --url devnet"
}

if [ -f "$KEYPAIR_FILE" ]; then
    PUBLIC_KEY=$(solana-keygen pubkey "$KEYPAIR_FILE" 2>/dev/null || echo "")
    if [ -n "$PUBLIC_KEY" ]; then
        solana airdrop 2 "$PUBLIC_KEY" --url devnet || {
            echo "⚠️  Airdrop failed. You may need to wait or use the faucet:"
            echo "   https://faucet.solana.com"
            echo "   Address: $PUBLIC_KEY"
        }
    fi
    rm -f "$KEYPAIR_FILE"
fi

echo ""
echo "🚀 Setup complete! Start Kora with:"
echo "   cd infra/kora && docker compose up"
echo ""
echo "📡 Kora will be available at: http://localhost:8080"
