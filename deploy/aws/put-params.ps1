# Uploads production settings to SSM Parameter Store, one parameter per line.
#
#   pwsh deploy/aws/put-params.ps1 -Profile dmarcharbor [-Region eu-central-1]
#
# Reads deploy/secrets/{api,web,tunnel,deploy}.env (git-ignored, KEY=VALUE per
# line, # for comments) and writes /dmarcharbor/prod/<file>/<KEY>. api, web and
# tunnel are SecureString (encrypted with the account's aws/ssm key); deploy
# holds hostnames only and is a plain String. Values go through a request file
# that is deleted afterwards, never through the command line, and are never
# printed. A parameter that exists is overwritten; one no longer in the file is
# left alone (remove it with `aws ssm delete-parameter`).
param(
  [string] $Profile = 'dmarcharbor',
  [string] $Region = 'eu-central-1',
  [string] $Dir = (Join-Path $PSScriptRoot '..\secrets')
)
$ErrorActionPreference = 'Stop'
$aws = 'C:\Program Files\Amazon\AWSCLIV2\aws.exe'
if (-not (Test-Path $aws)) { $aws = 'aws' }

foreach ($group in 'api', 'web', 'tunnel', 'deploy') {
  $file = Join-Path $Dir "$group.env"
  if (-not (Test-Path $file)) { Write-Host "skip $group (no $file)"; continue }
  $count = 0
  foreach ($line in Get-Content $file) {
    if ($line -match '^\s*(#|$)') { continue }
    if ($line -notmatch '^([A-Z][A-Z0-9_]*)=(.*)$') { throw "Unreadable line in $group.env (not KEY=VALUE)." }
    $name = $Matches[1]; $value = $Matches[2]
    if ($value -eq '') { Write-Host "skip $group/$name (empty)"; continue }
    $request = [ordered]@{
      Name      = "/dmarcharbor/prod/$group/$name"
      Value     = $value
      Type      = $(if ($group -eq 'deploy') { 'String' } else { 'SecureString' })
      Overwrite = $true
      Tier      = 'Standard'
    }
    $tmp = New-TemporaryFile
    try {
      $request | ConvertTo-Json -Compress | Set-Content -Path $tmp -Encoding utf8NoBOM
      & $aws ssm put-parameter --profile $Profile --region $Region --cli-input-json "file://$tmp" --output text --query Version | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "put-parameter failed for $group/$name" }
    } finally {
      Remove-Item $tmp -Force
    }
    $count += 1
  }
  Write-Host "$group`: $count parameters written"
}
