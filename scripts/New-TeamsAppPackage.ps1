[CmdletBinding()]
param(
    [ValidatePattern('^\d+\.\d+\.\d+$')][string] $AppVersion = '0.1.0',
    [string] $OutputPath = (Join-Path (Split-Path $PSScriptRoot -Parent) 'teams-app/auth-notifications.zip'),
    [ValidatePattern('^https://')][string] $PrivacyUrl = 'https://github.com/nathanmcnulty/azd-auth-notifications/blob/main/docs/privacy.md',
    [ValidatePattern('^https://')][string] $TermsOfUseUrl = 'https://github.com/nathanmcnulty/azd-auth-notifications/blob/main/docs/terms.md'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
function Get-EnvironmentValue([string] $Name) {
    $value = (& azd env get-value $Name 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $value) { throw "$Name is required from the initialized azd environment." }
    return $value
}
$appId = Get-EnvironmentValue 'TEAMS_BOT_APP_ID'
$functionUrl = Get-EnvironmentValue 'AZURE_FUNCTION_APP_URL'
$parsedAppId = [guid]::Empty
if (-not [guid]::TryParse($appId, [ref]$parsedAppId)) { throw 'TEAMS_BOT_APP_ID must be a UUID.' }
try { $functionUri = [uri]$functionUrl } catch { throw 'AZURE_FUNCTION_APP_URL must be a valid HTTPS URL.' }
if ($functionUri.Scheme -ne 'https' -or -not $functionUri.Host -or $functionUri.UserInfo -or $functionUri.Port -ne 443) {
    throw 'AZURE_FUNCTION_APP_URL must be an HTTPS host URL without credentials or a custom port.'
}
$hostName = $functionUri.Host
$staging = Join-Path ([IO.Path]::GetTempPath()) "auth-notifications-teams-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $staging -Force | Out-Null

function New-TeamsPng {
    param([Parameter(Mandatory)][string] $Path, [Parameter(Mandatory)][int] $Width, [Parameter(Mandatory)][int] $Height, [Parameter(Mandatory)][System.Drawing.Color] $Color)
    Add-Type -AssemblyName System.Drawing
    $bitmap = [Drawing.Bitmap]::new($Width, $Height, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.Clear($Color)
        $bitmap.Save($Path, [Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}
function Test-TeamsPng {
    param([Parameter(Mandatory)][string] $Path, [Parameter(Mandatory)][int] $Width, [Parameter(Mandatory)][int] $Height, [Parameter(Mandatory)][bool] $MustBeTransparent)
    $image = [Drawing.Bitmap]::new($Path)
    try {
        if ($image.Width -ne $Width -or $image.Height -ne $Height) { throw "PNG '$Path' must be ${Width}x${Height}." }
        if ($MustBeTransparent -and $image.GetPixel(0, 0).A -ne 0) { throw "PNG '$Path' must have a transparent background." }
    } finally { $image.Dispose() }
}
try {
    $manifest = @{ '$schema' = 'https://developer.microsoft.com/json-schemas/teams/v1.17/MicrosoftTeams.schema.json'; manifestVersion = '1.17'; version = $AppVersion; id = $appId; developer = @{ name = 'Authentication notifications'; websiteUrl = 'https://github.com/nathanmcnulty/azd-auth-notifications'; privacyUrl = $PrivacyUrl; termsOfUseUrl = $TermsOfUseUrl }; name = @{ short = 'Auth notifications'; full = 'Authentication notifications' }; description = @{ short = 'Authentication notification delivery.'; full = 'Delivers authentication notifications in personal chats.' }; icons = @{ outline = 'outline.png'; color = 'color.png' }; accentColor = '#005A9E'; bots = @(@{ botId = $appId; scopes = @('personal'); supportsFiles = $false; isNotificationOnly = $true }); permissions = @('identity'); validDomains = @($hostName) }
    $manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $staging 'manifest.json') -Encoding utf8NoBOM
    New-TeamsPng -Path (Join-Path $staging 'color.png') -Width 192 -Height 192 -Color ([System.Drawing.Color]::FromArgb(255, 0, 90, 158))
    New-TeamsPng -Path (Join-Path $staging 'outline.png') -Width 32 -Height 32 -Color ([System.Drawing.Color]::FromArgb(0, 0, 0, 0))
    Test-TeamsPng -Path (Join-Path $staging 'color.png') -Width 192 -Height 192 -MustBeTransparent $false
    Test-TeamsPng -Path (Join-Path $staging 'outline.png') -Width 32 -Height 32 -MustBeTransparent $true
    New-Item -ItemType Directory -Path (Split-Path $OutputPath -Parent) -Force | Out-Null
    Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $OutputPath -Force
    Write-Host "Teams personal app package created: $OutputPath"
} finally {
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $resolvedStaging = (Resolve-Path -LiteralPath $staging -ErrorAction SilentlyContinue).Path
    if ($resolvedStaging -and $resolvedStaging.StartsWith("$tempRoot$([IO.Path]::DirectorySeparatorChar)", [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $resolvedStaging -Recurse -Force -ErrorAction SilentlyContinue
    }
}
