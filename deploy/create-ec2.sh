#!/usr/bin/env bash
# Provision an EC2 instance for committee-sync-backend.
# Installs Docker + Docker Compose on first boot.
#
# Prerequisites:
#   - AWS CLI configured with appropriate credentials
#   - An SSH key pair (will be imported if not already in AWS)
#
# Usage: ./deploy/create-ec2.sh
set -euo pipefail

# ── Configuration ──
INSTANCE_NAME="committee-sync-backend"
REGION="eu-central-1"
INSTANCE_TYPE="t3.small"
DISK_SIZE=20
KEY_NAME="OrbsSharedSSH"
SSH_PUB_KEY_PATH=""  # Already in AWS, no import needed
AMI_ID=""

# ── Resolve latest Ubuntu 22.04 AMI ──
AMI_ID=$(aws ec2 describe-images \
  --region "$REGION" \
  --owners 099720109477 \
  --filters "Name=name,Values=ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*" \
            "Name=state,Values=available" \
  --query 'Images | sort_by(@, &CreationDate) | [-1].ImageId' \
  --output text)
echo "Using AMI: $AMI_ID"

# ── Import SSH key if not already present ──
if ! aws ec2 describe-key-pairs --region "$REGION" --key-names "$KEY_NAME" &>/dev/null; then
  echo "Importing SSH key $KEY_NAME..."
  OPENSSH_PUB_B64=$(ssh-keygen -i -m PKCS8 -f "$SSH_PUB_KEY_PATH" | base64)
  aws ec2 import-key-pair \
    --region "$REGION" \
    --key-name "$KEY_NAME" \
    --public-key-material "$OPENSSH_PUB_B64"
else
  echo "SSH key $KEY_NAME already exists in $REGION"
fi

# ── Create security group if it doesn't exist ──
SG_NAME="committee-sync-sg"
SG_ID=$(aws ec2 describe-security-groups \
  --region "$REGION" \
  --filters "Name=group-name,Values=$SG_NAME" \
  --query 'SecurityGroups[0].GroupId' \
  --output text 2>/dev/null || echo "None")

if [ "$SG_ID" = "None" ] || [ -z "$SG_ID" ]; then
  echo "Creating security group $SG_NAME..."
  SG_ID=$(aws ec2 create-security-group \
    --region "$REGION" \
    --group-name "$SG_NAME" \
    --description "committee-sync-backend - dashboard + sync service" \
    --query 'GroupId' \
    --output text)

  # SSH
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" \
    --protocol tcp --port 22 --cidr 0.0.0.0/0

  # HTTP (dashboard + ACME challenge)
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" \
    --protocol tcp --port 80 --cidr 0.0.0.0/0

  # HTTPS (dashboard via Caddy + Let's Encrypt)
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" \
    --protocol tcp --port 443 --cidr 0.0.0.0/0

  echo "Security group created: $SG_ID"
else
  echo "Security group $SG_NAME already exists: $SG_ID"
fi

# ── User data: install Docker + Docker Compose on first boot ──
USER_DATA=$(cat <<'USERDATA'
#!/bin/bash
set -e
export DEBIAN_FRONTEND=noninteractive

# Update system
apt-get update && apt-get upgrade -y

# Install Docker
apt-get install -y ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Allow ubuntu user to use Docker without sudo
usermod -aG docker ubuntu

# Install git
apt-get install -y git

echo "Bootstrap complete — Docker $(docker --version) installed"
USERDATA
)

# ── Launch instance ──
echo "Launching EC2 instance..."
INSTANCE_ID=$(aws ec2 run-instances \
  --region "$REGION" \
  --image-id "$AMI_ID" \
  --instance-type "$INSTANCE_TYPE" \
  --key-name "$KEY_NAME" \
  --security-group-ids "$SG_ID" \
  --block-device-mappings "DeviceName=/dev/sda1,Ebs={VolumeSize=$DISK_SIZE,VolumeType=gp3}" \
  --user-data "$USER_DATA" \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$INSTANCE_NAME},{Key=owner,Value=orbs},{Key=description,Value=committee-sync-backend - syncs ORBS L3 committee to EVM chains}]" \
  --query 'Instances[0].InstanceId' \
  --output text)

echo "Instance ID: $INSTANCE_ID"
echo "Waiting for instance to be running..."
aws ec2 wait instance-running --region "$REGION" --instance-ids "$INSTANCE_ID"

# Get public IP
PUBLIC_IP=$(aws ec2 describe-instances \
  --region "$REGION" \
  --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' \
  --output text)

echo ""
echo "============================================"
echo "  Instance Name:  $INSTANCE_NAME"
echo "  Instance ID:    $INSTANCE_ID"
echo "  Public IP:      $PUBLIC_IP"
echo "  Region:         $REGION"
echo "  Instance Type:  $INSTANCE_TYPE"
echo "  Disk:           ${DISK_SIZE}GB gp3"
echo "============================================"
echo ""
echo "SSH:  ssh -i ~/.ssh/$KEY_NAME ubuntu@$PUBLIC_IP"
echo ""
echo "Deploy steps:"
echo "  1. ssh ubuntu@$PUBLIC_IP"
echo "  2. git clone <repo-url> committee-sync-backend"
echo "  3. cd committee-sync-backend"
echo "  4. cp deploy/.env.example .env && vi .env"
echo "  5. cd deploy && docker compose up -d"
echo "  6. docker compose logs -f backend"
echo ""
echo "Ports open: 22 (SSH), 80 (HTTP/ACME), 443 (HTTPS/Dashboard)"
echo "============================================"
