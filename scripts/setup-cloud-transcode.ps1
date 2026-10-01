# One-time setup for Google Cloud Transcoder (run by a project owner in PowerShell with gcloud logged in).
# It enables the API, creates a private bucket that deletes objects after 1 day, grants the VM's
# service account the minimum roles, then restarts the VM once so it can call Google APIs.
# Afterwards set TRANSCODE_BUCKET=livehub-510209-transcode in .env.production on the VM and run
#   sudo docker compose --env-file .env.production -f compose.production.yaml up -d api
$ErrorActionPreference = 'Stop'
$project = 'livehub-510209'
$zone = 'asia-southeast1-c'
$vm = 'ggz24livehub'
$bucket = "$project-transcode"
$number = (gcloud projects describe $project --format='value(projectNumber)')
$vmAccount = "$number-compute@developer.gserviceaccount.com"
$agent = "service-$number@gcp-sa-transcoder.iam.gserviceaccount.com"

gcloud services enable transcoder.googleapis.com --project=$project

gcloud storage buckets create "gs://$bucket" --project=$project --location=asia-southeast1 `
  --uniform-bucket-level-access --public-access-prevention
$lifecycle = Join-Path $env:TEMP 'transcode-lifecycle.json'
'{"rule":[{"action":{"type":"Delete"},"condition":{"age":1}}]}' | Set-Content $lifecycle -Encoding ascii
gcloud storage buckets update "gs://$bucket" --lifecycle-file=$lifecycle

gcloud storage buckets add-iam-policy-binding "gs://$bucket" `
  --member="serviceAccount:$vmAccount" --role=roles/storage.objectAdmin
gcloud storage buckets add-iam-policy-binding "gs://$bucket" `
  --member="serviceAccount:$agent" --role=roles/storage.objectAdmin
gcloud projects add-iam-policy-binding $project `
  --member="serviceAccount:$vmAccount" --role=roles/transcoder.admin --condition=None

# The VM currently only has read-only storage scopes; this needs a stop/start (about 2-3 minutes).
gcloud compute instances stop $vm --zone=$zone --project=$project
gcloud compute instances set-service-account $vm --zone=$zone --project=$project `
  --service-account=$vmAccount --scopes=cloud-platform
gcloud compute instances start $vm --zone=$zone --project=$project
Write-Output "Done. Bucket: $bucket"
