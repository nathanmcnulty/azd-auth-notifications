[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
foreach ($command in @('az', 'azd')) { if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "Required command '$command' was not found." } }
function Get-EnvironmentValue([string] $Name) {
    $value = (& azd env get-value $Name 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $value) { throw "$Name is required to deploy the Function package." }
    return $value
}
$subscriptionId = Get-EnvironmentValue 'AZURE_SUBSCRIPTION_ID'
$resourceGroup = Get-EnvironmentValue 'AZURE_RESOURCE_GROUP'
$functionName = Get-EnvironmentValue 'AZURE_FUNCTION_APP_NAME'
$tenantId = Get-EnvironmentValue 'AZURE_TENANT_ID'
$account = & az account show --subscription $subscriptionId --query tenantId -o tsv
if ($LASTEXITCODE -ne 0 -or $account.Trim() -ne $tenantId) { throw 'Azure CLI tenant does not match AZURE_TENANT_ID.' }
$resource = & az functionapp show --subscription $subscriptionId --resource-group $resourceGroup --name $functionName --query "{name:name,rg:resourceGroup,tags:tags}" -o json | ConvertFrom-Json
if ($resource.name -ne $functionName -or $resource.rg -ne $resourceGroup -or $resource.tags.'azd-env-name' -ne (Get-EnvironmentValue 'AZURE_ENV_NAME')) { throw 'The Function App target does not match this azd environment.' }

$repositoryRoot = Split-Path $PSScriptRoot -Parent
$dist = Join-Path $repositoryRoot 'dist'
Push-Location $repositoryRoot
try {
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw 'npm run build failed.' }
} finally { Pop-Location }
foreach ($file in @('index.cjs', 'index.cjs.LEGAL.txt', 'host.json', 'package.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $dist $file) -PathType Leaf)) { throw "dist/$file is required. Run npm run build first." }
}
$license = Join-Path $repositoryRoot 'LICENSE'
if (-not (Test-Path -LiteralPath $license -PathType Leaf)) { throw 'LICENSE is required for the deployment artifact.' }
$archive = Join-Path ([IO.Path]::GetTempPath()) "auth-notifications-$([guid]::NewGuid()).zip"
try {
    Compress-Archive -LiteralPath @((Join-Path $dist 'index.cjs'), (Join-Path $dist 'index.cjs.LEGAL.txt'), (Join-Path $dist 'host.json'), (Join-Path $dist 'package.json'), $license) -DestinationPath $archive -CompressionLevel Optimal
    & az functionapp deployment source config-zip --subscription $subscriptionId --resource-group $resourceGroup --name $functionName --src $archive --build-remote false --only-show-errors
    if ($LASTEXITCODE -ne 0) { throw 'Azure Function package deployment failed.' }
} finally { Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue }
