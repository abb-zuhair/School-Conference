<#
    deploy.ps1 - put an update live on appointments.aca.edu.kw

    From inside the School-Conference folder:

        .\deploy.ps1 -Zip "$HOME\Downloads\School-Conference.zip"

    or, when this folder already holds the new commits and they only need sending:

        .\deploy.ps1

    In order: it refuses to run if you have unsaved work here, opens the
    database backup in your browser, copies your .env and data folder
    somewhere safe, lays the update over this folder, shows you exactly which
    commits are about to go, and pushes.

    It stops at the first sign of trouble and says what it found. It never
    touches the live database - that lives on the Railway volume, and
    deploying does not go near it.
#>

[CmdletBinding()]
param(
    # The update zip. Leave it out if this folder already holds the new commits.
    [string] $Zip,

    # The repository folder. Defaults to wherever this script is sitting.
    [string] $Repo = $PSScriptRoot,

    # Skip the backup prompt - only when you have just taken one.
    [switch] $SkipBackup,

    # The site, if it ever moves.
    [string] $SiteUrl = 'https://appointments.aca.edu.kw'
)

# Deliberately not 'Stop': git writes ordinary progress to stderr, which would
# abort the script for no reason. Every step below is checked explicitly
# instead, and the cmdlets that must not fail quietly say so themselves.
# Keep this file plain ASCII. Windows PowerShell reads a file with no BOM
# using the ANSI codepage, where the last byte of a UTF-8 em dash is a curly
# quote - which the parser treats as a string delimiter, wrecking everything
# after it. test/features.js fails if a non-ASCII character creeps back in.
$ErrorActionPreference = 'Continue'

function Say      ([string] $m) { Write-Host "`n$m" -ForegroundColor Cyan }
function Good     ([string] $m) { Write-Host "  $m" -ForegroundColor Green }
function Stop-With ([string] $m) { Write-Host "`n  $m`n" -ForegroundColor Red; exit 1 }

# --------------------------------------------------------------------------
# Step 0: Is this a real repo, and is git here?
# --------------------------------------------------------------------------
if (-not $Repo) {
    Stop-With "No folder to work in. Run this from inside the project, or pass -Repo ""C:\path\to\School-Conference""."
}
if (-not (Test-Path -LiteralPath $Repo)) { Stop-With "There is no folder at $Repo" }
$Repo = (Resolve-Path -LiteralPath $Repo).Path

if (-not (Test-Path -LiteralPath (Join-Path $Repo '.git'))) {
    Stop-With @"
$Repo is not the project folder - there is no .git in it.

Put deploy.ps1 inside your School-Conference folder and run it from there,
or tell it where that folder is:

    .\deploy.ps1 -Repo "C:\path\to\School-Conference" -Zip "$HOME\Downloads\School-Conference.zip"
"@
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Stop-With "git is not installed, or not on PATH. Install Git for Windows, then run this again."
}

Push-Location -LiteralPath $Repo
try {
    Say "Deploying from $Repo"

    # ----------------------------------------------------------------------
    # Step 1: Never bulldoze your own edits
    # ----------------------------------------------------------------------
    $dirty = @(git status --porcelain)
    if ($LASTEXITCODE -ne 0) { Stop-With "git could not read this folder. Is it really the project repo?" }
    if ($dirty.Count -gt 0) {
        Write-Host ""
        $dirty | ForEach-Object { Write-Host "    $_" -ForegroundColor Yellow }
        Stop-With "There are uncommitted changes here. Commit or undo them first, so nothing of yours is lost."
    }
    Good "Working folder is clean."

    # ----------------------------------------------------------------------
    # Step 2: Back up the live database
    # ----------------------------------------------------------------------
    if (-not $SkipBackup) {
        Say "Back up the live database first"
        Write-Host "  Opening the backup link - sign in as admin if asked, and save the file."
        Start-Process "$SiteUrl/admin/backup.db"
        if ((Read-Host "  Saved it? Type y to carry on") -ne 'y') {
            Stop-With "Stopped. Nothing has been changed."
        }
    }

    # ----------------------------------------------------------------------
    # Step 3: Keep a copy of the files that are yours alone
    # ----------------------------------------------------------------------
    $stamp  = Get-Date -Format 'yyyy-MM-dd_HHmm'
    $safety = Join-Path (Split-Path -Parent $Repo) 'school-conference-safety'
    $safety = Join-Path $safety $stamp
    $kept   = @()
    foreach ($item in @('.env', 'data')) {
        $source = Join-Path $Repo $item
        if (Test-Path -LiteralPath $source) {
            New-Item -ItemType Directory -Force -Path $safety -ErrorAction Stop | Out-Null
            Copy-Item -LiteralPath $source -Destination $safety -Recurse -Force -ErrorAction Stop
            $kept += $item
        }
    }
    if ($kept.Count -gt 0) { Good "Copied $($kept -join ' and ') to $safety" }

    # ----------------------------------------------------------------------
    # Step 4: Lay the update over this folder
    # ----------------------------------------------------------------------
    if ($Zip) {
        if (-not (Test-Path -LiteralPath $Zip)) { Stop-With "Cannot find the zip at $Zip" }
        Say "Unpacking the update"

        $temp = Join-Path ([System.IO.Path]::GetTempPath()) "sc-deploy-$stamp"
        if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force }
        Expand-Archive -LiteralPath $Zip -DestinationPath $temp -Force -ErrorAction Stop

        # The zip holds a single folder; its contents belong in the repo root.
        $inner = @(Get-ChildItem -LiteralPath $temp -Directory)
        if ($inner.Count -ne 1) { Stop-With "That zip does not look right - expected one folder inside it." }
        $from = $inner[0].FullName
        if (-not (Test-Path -LiteralPath (Join-Path $from 'package.json'))) {
            Stop-With "That zip does not look like the application - there is no package.json inside."
        }

        # robocopy, not Copy-Item: it merges folders predictably. /E brings
        # subfolders and only ever adds or overwrites - there is no /MIR here,
        # so nothing already in the repo is deleted.
        robocopy $from $Repo /E /NFL /NDL /NJH /NJS /NP | Out-Null
        if ($LASTEXITCODE -ge 8) { Stop-With "Copying the files failed (robocopy code $LASTEXITCODE). Nothing was pushed." }
        $global:LASTEXITCODE = 0

        Remove-Item -LiteralPath $temp -Recurse -Force
        Good "Unpacked. Your .env and data folder are not in the zip, so they were left alone."
    }

    # ----------------------------------------------------------------------
    # Step 5: Show what is about to go, then send it
    # ----------------------------------------------------------------------
    Say "Checking what is new"
    git fetch origin --quiet
    if ($LASTEXITCODE -ne 0) { Stop-With "Could not reach GitHub. Check your connection and try again - nothing was pushed." }

    $ahead = @(git log --oneline origin/main..HEAD)
    if ($ahead.Count -eq 0) {
        Good "GitHub already has everything in this folder. Nothing to push."
        Write-Host ""
        exit 0
    }
    $ahead | ForEach-Object { Write-Host "    $_" }

    $behind = @(git log --oneline HEAD..origin/main)
    if ($behind.Count -gt 0) {
        Write-Host ""
        $behind | ForEach-Object { Write-Host "    $_" -ForegroundColor Yellow }
        Stop-With "GitHub has commits this folder does not. Stopping rather than overwriting them - bring this up in the chat before going further."
    }

    Say "Pushing"
    git push origin main
    if ($LASTEXITCODE -ne 0) {
        git push --set-upstream origin main
        if ($LASTEXITCODE -ne 0) { Stop-With "The push failed. Copy the message above into the chat." }
    }
    Good "Pushed. Railway rebuilds on its own - give it a minute or two."

    # ----------------------------------------------------------------------
    # Step 6: What to look at once it is up
    # ----------------------------------------------------------------------
    Say "When the deploy finishes, check:"
    Write-Host "    1. Your bookings and staff are all still there."
    Write-Host "    2. No red storage warning on the admin dashboard (that means the /data volume is mounted)."
    Write-Host "    3. The new features are where they should be."
    Write-Host ""
}
finally {
    Pop-Location
}
