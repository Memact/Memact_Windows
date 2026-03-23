$ErrorActionPreference = "Stop"

Set-Location (Split-Path -Parent $PSScriptRoot)

git lfs track "*.gguf"
git lfs migrate import --include="*.gguf"

Write-Host "Git LFS is now tracking .gguf files and existing history has been migrated."
