# HandMocap local server for Windows (no installs needed).
# Serves this folder at http://localhost:8080 (or the next free port up to 8090) using the
# built-in .NET HttpListener, then opens it in the default browser.
# Only this computer can connect (localhost). Close the window to stop the server.
# Started by "Start HandMocap.bat". Works with Windows PowerShell 5.1 and PowerShell 7.

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $root.EndsWith([System.IO.Path]::DirectorySeparatorChar)) { $root += [System.IO.Path]::DirectorySeparatorChar }

$types = @{
  '.html' = 'text/html; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.mjs'  = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.md'   = 'text/plain; charset=utf-8'
  '.txt'  = 'text/plain; charset=utf-8'
  '.svg'  = 'image/svg+xml'
  '.png'  = 'image/png'
  '.glb'  = 'model/gltf-binary'
  '.gltf' = 'model/gltf+json'
  '.bin'  = 'application/octet-stream'
  '.wasm' = 'application/wasm'
  '.task' = 'application/octet-stream'
}

$listener = $null
foreach ($port in 8080..8090) {
  $candidate = New-Object System.Net.HttpListener
  $candidate.Prefixes.Add("http://localhost:$port/")
  try {
    $candidate.Start()
    $listener = $candidate
    break
  } catch {
    $candidate.Close()
  }
}
if ($null -eq $listener) {
  Write-Host 'Could not start: ports 8080 to 8090 are all in use.'
  Read-Host 'Press Enter to close'
  exit 1
}

$url = "http://localhost:$port/"
Write-Host ''
Write-Host "  HandMocap is running at $url"
Write-Host '  Keep this window open while you use it. Close it to stop the server.'
Write-Host ''
if ($env:HANDMOCAP_NO_BROWSER -ne '1') { Start-Process $url }

while ($listener.IsListening) {
  try {
    $context = $listener.GetContext()
  } catch {
    break
  }
  $response = $context.Response
  try {
    $path = [System.Uri]::UnescapeDataString($context.Request.Url.AbsolutePath)
    if ($path.EndsWith('/')) { $path += 'index.html' }
    $relative = $path.TrimStart('/').Replace('/', [System.IO.Path]::DirectorySeparatorChar)
    $file = [System.IO.Path]::GetFullPath((Join-Path $root $relative))
    $status = 200
    if (-not $file.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
      $status = 403
    } elseif (-not [System.IO.File]::Exists($file)) {
      $status = 404
    }
    if ($status -eq 200) {
      $bytes = [System.IO.File]::ReadAllBytes($file)
      $ext = [System.IO.Path]::GetExtension($file).ToLowerInvariant()
      $type = $types[$ext]
      if ($null -eq $type) { $type = 'application/octet-stream' }
      $response.ContentType = $type
    } else {
      $bytes = [System.Text.Encoding]::UTF8.GetBytes("$status")
      $response.ContentType = 'text/plain; charset=utf-8'
    }
    $response.StatusCode = $status
    $response.Headers.Add('Cache-Control', 'no-cache')
    $response.Headers.Add('X-Content-Type-Options', 'nosniff')
    $response.ContentLength64 = $bytes.Length
    if ($context.Request.HttpMethod -ne 'HEAD') { $response.OutputStream.Write($bytes, 0, $bytes.Length) }
    Write-Host ("  {0} {1}" -f $status, $path)
  } catch {
    Write-Host ("  error: {0}" -f $_.Exception.Message)
  } finally {
    try { $response.OutputStream.Close() } catch {}
  }
}
