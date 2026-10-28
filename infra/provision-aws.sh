#!/usr/bin/env bash
# Provisions the AWS infrastructure for Imageinary: a VPC with two public
# subnets, security groups, an S3 bucket, an IAM role for the EC2 instance,
# a single-AZ RDS PostgreSQL instance, and an EC2 instance with an Elastic IP.
#
# This script only turns infrastructure ON. It does not install Docker, build
# images, or deploy the application — follow SETUP.md sections 6-10 for that
# once this script finishes and prints the EC2 host.
#
# Safe to re-run: every resource ID is cached in infra/.generated/state.env
# and reused on the next run instead of being recreated.
set -euo pipefail
export AWS_PAGER=""

# ====================== EDIT THESE BEFORE RUNNING ======================
AWS_PROFILE="imageinary"          # from: aws configure --profile imageinary
AWS_REGION="ap-south-1"           # pick one region and keep it everywhere
BUCKET_NAME="imageinary-media-526695891279"  # globally unique, lowercase, digits, hyphens only, no dots
EC2_INSTANCE_TYPE="t3.small"      # t3.micro (1GiB RAM) can OOM during docker build; t3.small (2GiB) is safer
DB_INSTANCE_CLASS="db.t4g.micro"  # fall back to db.t3.micro if unavailable in your region
DB_ALLOCATED_STORAGE_GB=20
DB_NAME="imageinary"
DB_MASTER_USERNAME="imageinary_admin"
# =========================================================================

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GEN_DIR="$HERE/.generated"
STATE_FILE="$GEN_DIR/state.env"
mkdir -p "$GEN_DIR"
chmod 700 "$GEN_DIR"
touch "$STATE_FILE"
chmod 600 "$STATE_FILE"
# shellcheck disable=SC1090
source "$STATE_FILE"

aws_() { aws --profile "$AWS_PROFILE" --region "$AWS_REGION" "$@"; }

save() { # save KEY value — persists to state file and the current shell
  local key="$1" val="$2"
  if grep -q "^${key}=" "$STATE_FILE" 2>/dev/null; then
    sed -i.bak "s#^${key}=.*#${key}=${val}#" "$STATE_FILE" && rm -f "${STATE_FILE}.bak"
  else
    echo "${key}=${val}" >> "$STATE_FILE"
  fi
  printf -v "$key" '%s' "$val"
}

have() { # have KEY — true if already cached from a previous run
  local val
  val="$(eval "echo \${$1:-}")"
  [[ -n "$val" ]]
}

echo "== Imageinary AWS provisioning =="
echo "Profile: $AWS_PROFILE   Region: $AWS_REGION"
IDENTITY="$(aws_ sts get-caller-identity --output json)" || {
  echo "Could not authenticate. Run: aws configure --profile $AWS_PROFILE" >&2
  exit 1
}
echo "$IDENTITY"
echo
echo "This will create BILLED resources: one EC2 instance, one RDS instance,"
echo "an S3 bucket, a VPC, and an Elastic IP. Review the CONFIG block at the"
echo "top of this script first."
read -r -p "Type 'yes' to continue: " CONFIRM
[[ "$CONFIRM" == "yes" ]] || { echo "Aborted."; exit 1; }

MY_IP="$(curl -s https://checkip.amazonaws.com)"
echo "Your current public IP (used for SSH access only): $MY_IP"

# ----------------------------- Networking -------------------------------
if ! have VPC_ID; then
  VPC_ID="$(aws_ ec2 create-vpc --cidr-block 10.0.0.0/16 \
    --tag-specifications 'ResourceType=vpc,Tags=[{Key=Name,Value=imageinary-vpc},{Key=Project,Value=imageinary}]' \
    --query 'Vpc.VpcId' --output text)"
  aws_ ec2 modify-vpc-attribute --vpc-id "$VPC_ID" --enable-dns-support '{"Value":true}'
  aws_ ec2 modify-vpc-attribute --vpc-id "$VPC_ID" --enable-dns-hostnames '{"Value":true}'
  save VPC_ID "$VPC_ID"
fi
echo "VPC: $VPC_ID"

if ! have IGW_ID; then
  IGW_ID="$(aws_ ec2 create-internet-gateway \
    --tag-specifications 'ResourceType=internet-gateway,Tags=[{Key=Name,Value=imageinary-igw}]' \
    --query 'InternetGateway.InternetGatewayId' --output text)"
  aws_ ec2 attach-internet-gateway --vpc-id "$VPC_ID" --internet-gateway-id "$IGW_ID"
  save IGW_ID "$IGW_ID"
fi
echo "Internet gateway: $IGW_ID"

AZ_LIST="$(aws_ ec2 describe-availability-zones \
  --filters Name=state,Values=available --query 'AvailabilityZones[0:2].ZoneName' --output text)"
AZ_A="$(echo "$AZ_LIST" | awk '{print $1}')"
AZ_B="$(echo "$AZ_LIST" | awk '{print $2}')"

if ! have SUBNET_A_ID; then
  SUBNET_A_ID="$(aws_ ec2 create-subnet --vpc-id "$VPC_ID" --cidr-block 10.0.1.0/24 --availability-zone "$AZ_A" \
    --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=imageinary-public-a}]' \
    --query 'Subnet.SubnetId' --output text)"
  aws_ ec2 modify-subnet-attribute --subnet-id "$SUBNET_A_ID" --map-public-ip-on-launch
  save SUBNET_A_ID "$SUBNET_A_ID"
fi
if ! have SUBNET_B_ID; then
  SUBNET_B_ID="$(aws_ ec2 create-subnet --vpc-id "$VPC_ID" --cidr-block 10.0.2.0/24 --availability-zone "$AZ_B" \
    --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=imageinary-public-b}]' \
    --query 'Subnet.SubnetId' --output text)"
  aws_ ec2 modify-subnet-attribute --subnet-id "$SUBNET_B_ID" --map-public-ip-on-launch
  save SUBNET_B_ID "$SUBNET_B_ID"
fi
echo "Subnets: $SUBNET_A_ID ($AZ_A), $SUBNET_B_ID ($AZ_B)"

if ! have ROUTE_TABLE_ID; then
  ROUTE_TABLE_ID="$(aws_ ec2 create-route-table --vpc-id "$VPC_ID" \
    --tag-specifications 'ResourceType=route-table,Tags=[{Key=Name,Value=imageinary-rt}]' \
    --query 'RouteTable.RouteTableId' --output text)"
  aws_ ec2 create-route --route-table-id "$ROUTE_TABLE_ID" --destination-cidr-block 0.0.0.0/0 --gateway-id "$IGW_ID" >/dev/null
  aws_ ec2 associate-route-table --route-table-id "$ROUTE_TABLE_ID" --subnet-id "$SUBNET_A_ID" >/dev/null
  aws_ ec2 associate-route-table --route-table-id "$ROUTE_TABLE_ID" --subnet-id "$SUBNET_B_ID" >/dev/null
  save ROUTE_TABLE_ID "$ROUTE_TABLE_ID"
fi
echo "Route table: $ROUTE_TABLE_ID"

# --------------------------- Security groups -----------------------------
if ! have SG_WEB_ID; then
  SG_WEB_ID="$(aws_ ec2 create-security-group --vpc-id "$VPC_ID" --group-name imageinary-web \
    --description "Imageinary EC2: public HTTP/HTTPS, SSH from operator only" \
    --query 'GroupId' --output text)"
  aws_ ec2 authorize-security-group-ingress --group-id "$SG_WEB_ID" --protocol tcp --port 80 --cidr 0.0.0.0/0 >/dev/null
  aws_ ec2 authorize-security-group-ingress --group-id "$SG_WEB_ID" --protocol tcp --port 443 --cidr 0.0.0.0/0 >/dev/null
  aws_ ec2 authorize-security-group-ingress --group-id "$SG_WEB_ID" --protocol tcp --port 22 --cidr "${MY_IP}/32" >/dev/null
  save SG_WEB_ID "$SG_WEB_ID"
fi
echo "Security group (EC2): $SG_WEB_ID — SSH allowed only from $MY_IP/32"

if ! have SG_RDS_ID; then
  SG_RDS_ID="$(aws_ ec2 create-security-group --vpc-id "$VPC_ID" --group-name imageinary-rds \
    --description "Imageinary RDS: Postgres from the EC2 security group only" \
    --query 'GroupId' --output text)"
  aws_ ec2 authorize-security-group-ingress --group-id "$SG_RDS_ID" --protocol tcp --port 5432 --source-group "$SG_WEB_ID" >/dev/null
  save SG_RDS_ID "$SG_RDS_ID"
fi
echo "Security group (RDS): $SG_RDS_ID"

# -------------------------------- S3 -------------------------------------
save BUCKET_NAME "$BUCKET_NAME"
if ! aws_ s3api head-bucket --bucket "$BUCKET_NAME" 2>/dev/null; then
  if [[ "$AWS_REGION" == "us-east-1" ]]; then
    aws_ s3api create-bucket --bucket "$BUCKET_NAME"
  else
    aws_ s3api create-bucket --bucket "$BUCKET_NAME" \
      --create-bucket-configuration LocationConstraint="$AWS_REGION"
  fi
  aws_ s3api wait bucket-exists --bucket "$BUCKET_NAME"
fi
echo "S3 bucket: $BUCKET_NAME"

aws_ s3api put-public-access-block --bucket "$BUCKET_NAME" \
  --public-access-block-configuration file://"$HERE/s3-public-access-block.json"

sed "s/REPLACE_WITH_BUCKET_NAME/$BUCKET_NAME/g" "$HERE/s3-bucket-policy.example.json" > "$GEN_DIR/s3-bucket-policy.json"
aws_ s3api put-bucket-policy --bucket "$BUCKET_NAME" --policy file://"$GEN_DIR/s3-bucket-policy.json"

aws_ s3api put-bucket-encryption --bucket "$BUCKET_NAME" --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

# CORS starts with localhost only; re-applied below once the EC2 host's sslip.io name is known.
cat > "$GEN_DIR/s3-cors.json" <<JSON
{"CORSRules":[{"AllowedOrigins":["http://localhost:5173"],"AllowedMethods":["PUT","GET","HEAD"],"AllowedHeaders":["content-type","x-amz-*"],"ExposeHeaders":["ETag"],"MaxAgeSeconds":300}]}
JSON
aws_ s3api put-bucket-cors --bucket "$BUCKET_NAME" --cors-configuration file://"$GEN_DIR/s3-cors.json"
echo "S3 public access block, bucket policy, SSE-S3, and initial CORS applied."

# ------------------------------- IAM --------------------------------------
if ! have IAM_ROLE_NAME; then
  IAM_ROLE_NAME="imageinary-ec2-role"
  cat > "$GEN_DIR/trust-policy.json" <<'JSON'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}
JSON
  aws_ iam create-role --role-name "$IAM_ROLE_NAME" \
    --assume-role-policy-document file://"$GEN_DIR/trust-policy.json" \
    --tags Key=Project,Value=imageinary >/dev/null
  save IAM_ROLE_NAME "$IAM_ROLE_NAME"
fi

sed "s/REPLACE_WITH_BUCKET_NAME/$BUCKET_NAME/g" "$HERE/iam-s3-policy.example.json" > "$GEN_DIR/iam-s3-policy.json"
aws_ iam put-role-policy --role-name "$IAM_ROLE_NAME" --policy-name imageinary-ciphertext-access \
  --policy-document file://"$GEN_DIR/iam-s3-policy.json"

if ! have IAM_INSTANCE_PROFILE_NAME; then
  IAM_INSTANCE_PROFILE_NAME="imageinary-ec2-profile"
  aws_ iam create-instance-profile --instance-profile-name "$IAM_INSTANCE_PROFILE_NAME" >/dev/null
  aws_ iam add-role-to-instance-profile --instance-profile-name "$IAM_INSTANCE_PROFILE_NAME" --role-name "$IAM_ROLE_NAME"
  save IAM_INSTANCE_PROFILE_NAME "$IAM_INSTANCE_PROFILE_NAME"
  echo "Waiting for IAM instance profile propagation..."
  sleep 15
fi
echo "IAM role: $IAM_ROLE_NAME, instance profile: $IAM_INSTANCE_PROFILE_NAME"

# -------------------------------- RDS -------------------------------------
if ! have DB_SUBNET_GROUP_NAME; then
  DB_SUBNET_GROUP_NAME="imageinary-db-subnet-group"
  aws_ rds create-db-subnet-group --db-subnet-group-name "$DB_SUBNET_GROUP_NAME" \
    --db-subnet-group-description "Imageinary RDS subnet group" \
    --subnet-ids "$SUBNET_A_ID" "$SUBNET_B_ID" >/dev/null
  save DB_SUBNET_GROUP_NAME "$DB_SUBNET_GROUP_NAME"
fi

if ! have DB_MASTER_PASSWORD; then
  DB_MASTER_PASSWORD="$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | head -c 24)"
  save DB_MASTER_PASSWORD "$DB_MASTER_PASSWORD"
  echo "Generated a new RDS master password (saved only to $STATE_FILE, mode 600 — not printed here)."
fi

if ! have DB_INSTANCE_ID; then
  DB_INSTANCE_ID="imageinary-db"
  ENGINE_VERSION="$(aws_ rds describe-db-engine-versions --engine postgres \
    --query 'sort_by(DBEngineVersions, &EngineVersion)[-1].EngineVersion' --output text)"
  aws_ rds create-db-instance \
    --db-instance-identifier "$DB_INSTANCE_ID" \
    --db-instance-class "$DB_INSTANCE_CLASS" \
    --engine postgres --engine-version "$ENGINE_VERSION" \
    --allocated-storage "$DB_ALLOCATED_STORAGE_GB" --storage-type gp3 \
    --db-name "$DB_NAME" \
    --master-username "$DB_MASTER_USERNAME" --master-user-password "$DB_MASTER_PASSWORD" \
    --vpc-security-group-ids "$SG_RDS_ID" --db-subnet-group-name "$DB_SUBNET_GROUP_NAME" \
    --no-publicly-accessible --no-multi-az --backup-retention-period 1 \
    --no-deletion-protection \
    --tags Key=Project,Value=imageinary >/dev/null
  save DB_INSTANCE_ID "$DB_INSTANCE_ID"
fi
echo "RDS instance: $DB_INSTANCE_ID (waiting for it to become available — this can take 5-10 minutes)"
aws_ rds wait db-instance-available --db-instance-identifier "$DB_INSTANCE_ID"
DB_ENDPOINT="$(aws_ rds describe-db-instances --db-instance-identifier "$DB_INSTANCE_ID" \
  --query 'DBInstances[0].Endpoint.Address' --output text)"
save DB_ENDPOINT "$DB_ENDPOINT"
echo "RDS endpoint: $DB_ENDPOINT"

# -------------------------------- EC2 --------------------------------------
if ! have KEY_PAIR_NAME; then
  KEY_PAIR_NAME="imageinary-key"
  KEY_PATH="$HOME/.ssh/imageinary-key.pem"
  if [[ ! -f "$KEY_PATH" ]]; then
    aws_ ec2 create-key-pair --key-name "$KEY_PAIR_NAME" --query 'KeyMaterial' --output text > "$KEY_PATH"
    chmod 400 "$KEY_PATH"
  fi
  save KEY_PAIR_NAME "$KEY_PAIR_NAME"
  save KEY_PATH "$KEY_PATH"
fi
echo "SSH key pair: $KEY_PAIR_NAME -> $KEY_PATH"

if ! have EC2_INSTANCE_ID; then
  AMI_ID="$(aws_ ec2 describe-images --owners 099720109477 \
    --filters "Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*" "Name=state,Values=available" \
    --query 'sort_by(Images, &CreationDate)[-1].ImageId' --output text)"
  EC2_INSTANCE_ID="$(aws_ ec2 run-instances \
    --image-id "$AMI_ID" --instance-type "$EC2_INSTANCE_TYPE" \
    --key-name "$KEY_PAIR_NAME" --subnet-id "$SUBNET_A_ID" \
    --security-group-ids "$SG_WEB_ID" \
    --iam-instance-profile "Name=$IAM_INSTANCE_PROFILE_NAME" \
    --metadata-options "HttpTokens=required,HttpPutResponseHopLimit=2,HttpEndpoint=enabled" \
    --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=20,VolumeType=gp3}' \
    --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=imageinary-ec2},{Key=Project,Value=imageinary}]' \
    --query 'Instances[0].InstanceId' --output text)"
  save EC2_INSTANCE_ID "$EC2_INSTANCE_ID"
fi
echo "EC2 instance: $EC2_INSTANCE_ID (waiting for it to start running)"
aws_ ec2 wait instance-running --instance-ids "$EC2_INSTANCE_ID"

if ! have EIP_ALLOC_ID; then
  EIP_ALLOC_ID="$(aws_ ec2 allocate-address --domain vpc \
    --tag-specifications 'ResourceType=elastic-ip,Tags=[{Key=Name,Value=imageinary-eip}]' \
    --query 'AllocationId' --output text)"
  save EIP_ALLOC_ID "$EIP_ALLOC_ID"
  aws_ ec2 associate-address --instance-id "$EC2_INSTANCE_ID" --allocation-id "$EIP_ALLOC_ID" >/dev/null
fi
EIP_ADDRESS="$(aws_ ec2 describe-addresses --allocation-ids "$EIP_ALLOC_ID" --query 'Addresses[0].PublicIp' --output text)"
save EIP_ADDRESS "$EIP_ADDRESS"
SSLIP_HOST="$(echo "$EIP_ADDRESS" | tr '.' '-').sslip.io"
save SSLIP_HOST "$SSLIP_HOST"
echo "Elastic IP: $EIP_ADDRESS   Public hostname: $SSLIP_HOST"

# Now that the public hostname is known, widen S3 CORS to allow it.
cat > "$GEN_DIR/s3-cors.json" <<JSON
{"CORSRules":[{"AllowedOrigins":["http://localhost:5173","https://${SSLIP_HOST}"],"AllowedMethods":["PUT","GET","HEAD"],"AllowedHeaders":["content-type","x-amz-*"],"ExposeHeaders":["ETag"],"MaxAgeSeconds":300}]}
JSON
aws_ s3api put-bucket-cors --bucket "$BUCKET_NAME" --cors-configuration file://"$GEN_DIR/s3-cors.json"
echo "S3 CORS updated to allow https://$SSLIP_HOST"

echo
echo "================================ DONE ================================"
echo "EC2 public host:     $SSLIP_HOST  ($EIP_ADDRESS)"
echo "SSH:                 ssh -i $KEY_PATH ubuntu@$EIP_ADDRESS"
echo "RDS endpoint:        $DB_ENDPOINT"
echo "RDS DB name/user:    $DB_NAME / $DB_MASTER_USERNAME"
echo "RDS master password: see $STATE_FILE (DB_MASTER_PASSWORD) — not printed"
echo "S3 bucket:            $BUCKET_NAME"
echo "IAM role:             $IAM_ROLE_NAME"
echo
echo "Next: follow SETUP.md sections 6-10 to install Docker on the host,"
echo "apply the SQL migration against \$DB_ENDPOINT, create .env with"
echo "DOMAIN=$SSLIP_HOST, and bring the stack up with docker compose."
echo "When you're done for the day, run infra/teardown-aws.sh to avoid"
echo "burning credits on an idle EC2/RDS pair."
