param(
  [Parameter(Mandatory=$true)][string]$PythonExecutable,
  [Parameter(Mandatory=$true)][string]$ComfyMain
)
$ErrorActionPreference='Stop'
$implementationRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$storeRoot=Join-Path $implementationRoot 'work/local-workspace'
foreach($runtimePath in @($PythonExecutable,$ComfyMain)){
  if(-not [IO.Path]::IsPathRooted($runtimePath) -or -not (Test-Path -LiteralPath $runtimePath -PathType Leaf)){throw 'Explicit existing runtime paths required'}
}
$nodeExecutable=(Get-Command node -ErrorAction Stop).Source
$tsxPath=Join-Path $implementationRoot 'node_modules/tsx/dist/cli.mjs'
if(-not (Test-Path -LiteralPath $tsxPath)){throw 'Installed workspace tsx missing'}
$listeners=@(Get-NetTCPConnection -LocalPort 4310 -State Listen -ErrorAction SilentlyContinue)
foreach($ownedProcessId in @($listeners.OwningProcess | Select-Object -Unique)){
  $ownedProcess=Get-CimInstance Win32_Process -Filter "ProcessId=$ownedProcessId"
  if(-not $ownedProcess -or $ownedProcess.Name -ne 'node.exe' -or
    $ownedProcess.CommandLine -notmatch [regex]::Escape($implementationRoot) -or
    $ownedProcess.CommandLine -notmatch 'tools[\\/]local-workspace\.ts'){
    throw 'Port 4310 is not owned by this workspace; process preserved'
  }
  $activeWorkers=@(Get-CimInstance Win32_Process -Filter "ParentProcessId=$ownedProcessId" | Where-Object {$_.CommandLine -match 'work[\\/]owned-comfy-worker-'})
  if($activeWorkers.Count -gt 0){throw 'An owned CPU worker is active; service preserved. Wait for completion before upgrading'}
  Stop-Process -Id $ownedProcessId
  Wait-Process -Id $ownedProcessId -Timeout 10 -ErrorAction SilentlyContinue
  if(Get-Process -Id $ownedProcessId -ErrorAction SilentlyContinue){throw 'Owned server did not stop; database copy not started'}
}
$caseName=(Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+[guid]::NewGuid().ToString()
$backupRoot=Join-Path $storeRoot ('backups/'+$caseName)
New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
foreach($name in @('postgres','assets','run-artifacts')){
  $sourcePath=Join-Path $storeRoot $name
  if(Test-Path -LiteralPath $sourcePath){Copy-Item -LiteralPath $sourcePath -Destination (Join-Path $backupRoot $name) -Recurse}
}
foreach($name in @('runtime.json','server.stdout.log','server.stderr.log')){
  $sourcePath=Join-Path $storeRoot $name
  if(Test-Path -LiteralPath $sourcePath){Copy-Item -LiteralPath $sourcePath -Destination (Join-Path $backupRoot $name)}
}
$verifiedFiles=0
foreach($name in @('postgres','assets','run-artifacts')){
  $sourceDirectory=Join-Path $storeRoot $name
  if(Test-Path -LiteralPath $sourceDirectory){
    foreach($sourceFile in Get-ChildItem -LiteralPath $sourceDirectory -File -Recurse){
      $relativeFile=[IO.Path]::GetRelativePath($sourceDirectory,$sourceFile.FullName)
      $backupFile=Join-Path (Join-Path $backupRoot $name) $relativeFile
      if((Get-FileHash -LiteralPath $sourceFile.FullName -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $backupFile -Algorithm SHA256).Hash){throw 'Private backup file hash mismatch'}
      $verifiedFiles++
    }
  }
}
$restoreRoot=Join-Path $backupRoot ('restore-check-'+[guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $restoreRoot | Out-Null
Copy-Item -LiteralPath (Join-Path $backupRoot 'postgres') -Destination (Join-Path $restoreRoot 'postgres') -Recurse
Push-Location $implementationRoot
try{
  & $nodeExecutable $tsxPath (Join-Path $PSScriptRoot 'verify-local-upgrade.ts') (Join-Path $restoreRoot 'postgres')
  if($LASTEXITCODE -ne 0){throw "Backup-copy migration failed; retained private backup: $backupRoot"}
}finally{Pop-Location}
@{pythonExecutable=$PythonExecutable;comfyMain=$ComfyMain} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $storeRoot 'runtime.json') -Encoding utf8
$started=Start-Process -FilePath $nodeExecutable -ArgumentList @(('"'+$tsxPath+'"'),'tools/local-workspace.ts') -WorkingDirectory $implementationRoot -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput (Join-Path $storeRoot 'server.stdout.log') -RedirectStandardError (Join-Path $storeRoot 'server.stderr.log')
$ready=$false
for($i=0;$i -lt 30;$i++){
  if($started.HasExited){throw "Workspace exited; inspect private server.stderr.log. Backup retained: $backupRoot"}
  try{$response=Invoke-WebRequest -Uri 'http://127.0.0.1:4310/v1/auth/setup' -TimeoutSec 1;if($response.StatusCode -eq 200){$ready=$true;break}}catch{}
  Start-Sleep -Milliseconds 250
}
if(-not $ready){throw "Workspace readiness timeout; preserve process and inspect logs. Backup retained: $backupRoot"}
$report=@{scope='local-workspace-backup-copy-verified-upgrade';ready=$true;launcherPid=$started.Id;verifiedBackupFiles=$verifiedFiles;backup=$backupRoot;restoreVerification=(Join-Path $restoreRoot 'verification.json');origin='http://127.0.0.1:4310'}
$report | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $backupRoot 'upgrade-report.json') -Encoding utf8
$report | ConvertTo-Json -Compress
