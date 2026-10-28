#!/usr/bin/env bash
# Deletes everything infra/provision-aws.sh created, reading IDs from
# infra/.generated/state.env. Run this when you're done for the day/demo to
# stop burning AWS credits. Safe to re-run: skips anything already gone.
set -uo pipefail
export AWS_PAGER=""

AWS_PROFILE="imageinary"
AWS_REGION="ap-south-1"   # must match provision-aws.sh

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_FILE="$HERE/.generated/state.env"
if [[ ! -f "$STATE_FILE" ]]; then
  echo "No state file at $STATE_FILE — nothing to tear down."
  exit 0
fi
# shellcheck disable=SC1090
source "$STATE_FILE"

aws_() { aws --profile "$AWS_PROFILE" --region "$AWS_REGION" "$@"; }

echo "== Imageinary AWS teardown =="
echo "This permanently deletes the EC2 instance, RDS instance (no final"
echo "snapshot), Elastic IP, S3 bucket contents, VPC, and IAM role created"
echo "by provision-aws.sh in profile $AWS_PROFILE / region $AWS_REGION."
read -r -p "Type 'yes' to continue: " CONFIRM
[[ "$CONFIRM" == "yes" ]] || { echo "Aborted."; exit 1; }

if [[ -n "${EC2_INSTANCE_ID:-}" ]]; then
  echo "Terminating EC2 instance $EC2_INSTANCE_ID..."
  aws_ ec2 terminate-instances --instance-ids "$EC2_INSTANCE_ID" >/dev/null 2>&1
  aws_ ec2 wait instance-terminated --instance-ids "$EC2_INSTANCE_ID" 2>/dev/null
fi

if [[ -n "${EIP_ALLOC_ID:-}" ]]; then
  echo "Releasing Elastic IP..."
  aws_ ec2 disassociate-address --allocation-id "$EIP_ALLOC_ID" >/dev/null 2>&1
  aws_ ec2 release-address --allocation-id "$EIP_ALLOC_ID" >/dev/null 2>&1
fi

if [[ -n "${DB_INSTANCE_ID:-}" ]]; then
  echo "Deleting RDS instance $DB_INSTANCE_ID (no final snapshot)..."
  aws_ rds delete-db-instance --db-instance-identifier "$DB_INSTANCE_ID" \
    --skip-final-snapshot --delete-automated-backups >/dev/null 2>&1
  aws_ rds wait db-instance-deleted --db-instance-identifier "$DB_INSTANCE_ID" 2>/dev/null
fi

if [[ -n "${DB_SUBNET_GROUP_NAME:-}" ]]; then
  echo "Deleting DB subnet group..."
  aws_ rds delete-db-subnet-group --db-subnet-group-name "$DB_SUBNET_GROUP_NAME" >/dev/null 2>&1
fi

if [[ -n "${BUCKET_NAME:-}" ]]; then
  echo "Emptying and deleting S3 bucket $BUCKET_NAME..."
  aws_ s3 rm "s3://$BUCKET_NAME" --recursive >/dev/null 2>&1
  aws_ s3api delete-bucket --bucket "$BUCKET_NAME" >/dev/null 2>&1
fi

if [[ -n "${IAM_INSTANCE_PROFILE_NAME:-}" && -n "${IAM_ROLE_NAME:-}" ]]; then
  echo "Deleting IAM instance profile and role..."
  aws_ iam remove-role-from-instance-profile --instance-profile-name "$IAM_INSTANCE_PROFILE_NAME" --role-name "$IAM_ROLE_NAME" >/dev/null 2>&1
  aws_ iam delete-instance-profile --instance-profile-name "$IAM_INSTANCE_PROFILE_NAME" >/dev/null 2>&1
fi
if [[ -n "${IAM_ROLE_NAME:-}" ]]; then
  aws_ iam delete-role-policy --role-name "$IAM_ROLE_NAME" --policy-name imageinary-ciphertext-access >/dev/null 2>&1
  aws_ iam delete-role --role-name "$IAM_ROLE_NAME" >/dev/null 2>&1
fi

if [[ -n "${KEY_PAIR_NAME:-}" ]]; then
  echo "Deleting EC2 key pair (local .pem file is left on disk; delete manually if you want)..."
  aws_ ec2 delete-key-pair --key-name "$KEY_PAIR_NAME" >/dev/null 2>&1
fi

if [[ -n "${SG_RDS_ID:-}" ]]; then
  aws_ ec2 delete-security-group --group-id "$SG_RDS_ID" >/dev/null 2>&1
fi
if [[ -n "${SG_WEB_ID:-}" ]]; then
  aws_ ec2 delete-security-group --group-id "$SG_WEB_ID" >/dev/null 2>&1
fi

if [[ -n "${ROUTE_TABLE_ID:-}" ]]; then
  for assoc in $(aws_ ec2 describe-route-tables --route-table-ids "$ROUTE_TABLE_ID" \
      --query 'RouteTables[0].Associations[?!Main].RouteTableAssociationId' --output text 2>/dev/null); do
    aws_ ec2 disassociate-route-table --association-id "$assoc" >/dev/null 2>&1
  done
  aws_ ec2 delete-route-table --route-table-id "$ROUTE_TABLE_ID" >/dev/null 2>&1
fi

for subnet in "${SUBNET_A_ID:-}" "${SUBNET_B_ID:-}"; do
  [[ -n "$subnet" ]] && aws_ ec2 delete-subnet --subnet-id "$subnet" >/dev/null 2>&1
done

if [[ -n "${IGW_ID:-}" && -n "${VPC_ID:-}" ]]; then
  aws_ ec2 detach-internet-gateway --internet-gateway-id "$IGW_ID" --vpc-id "$VPC_ID" >/dev/null 2>&1
  aws_ ec2 delete-internet-gateway --internet-gateway-id "$IGW_ID" >/dev/null 2>&1
fi

if [[ -n "${VPC_ID:-}" ]]; then
  echo "Deleting VPC $VPC_ID..."
  aws_ ec2 delete-vpc --vpc-id "$VPC_ID" >/dev/null 2>&1
fi

echo
echo "Teardown finished. Double-check in the AWS console: EC2, RDS, VPC, S3,"
echo "IAM, and Elastic IPs (unassociated EIPs are billed hourly)."
echo "Clearing local state file: $STATE_FILE"
rm -f "$STATE_FILE"
