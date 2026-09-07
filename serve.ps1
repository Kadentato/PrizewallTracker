# Static file server + tiny API for the Prizewall app.
# No Node/Python needed. Run:  powershell -ExecutionPolicy Bypass -File serve.ps1
#   GET  /api/130point?q=<query>  -> proxies a sales search to 130point's backend (avoids CORS/Cloudflare on the front end)
#   POST /api/save                -> writes the posted JSON to prizewall.json (the app calls this after a sync)
$root = $PSScriptRoot
$prefix = "http://localhost:8798/"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)
$listener.Start()
Write-Host "Prizewall serving $root at $prefix (Ctrl+C to stop)"

$types = @{
  ".html" = "text/html; charset=utf-8"
  ".js"   = "application/javascript; charset=utf-8"
  ".jsx"  = "text/babel; charset=utf-8"
  ".json" = "application/json; charset=utf-8"
  ".webmanifest" = "application/manifest+json; charset=utf-8"
  ".css"  = "text/css; charset=utf-8"
  ".svg"  = "image/svg+xml"
  ".png"  = "image/png"
  ".ico"  = "image/x-icon"
}
$cache = @{}   # query -> @{At; Html}; 130point rate-limits bursts, so repeats within 45 min are served locally
$script:limitUntil = Get-Date   # set from 130point's Retry-After when it answers 429
$UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"

function Send-Bytes($res, $bytes, $ct, $code) {
  $res.StatusCode = $code
  $res.ContentType = $ct
  $res.Headers.Add("Cache-Control", "no-cache, no-store, must-revalidate")
  $res.ContentLength64 = $bytes.Length
  $res.OutputStream.Write($bytes, 0, $bytes.Length)
}
function Send-Text($res, $text, $ct, $code) { Send-Bytes $res ([System.Text.Encoding]::UTF8.GetBytes($text)) $ct $code }

while ($listener.IsListening) {
  try { $ctx = $listener.GetContext() } catch { break }
  $req = $ctx.Request
  $res = $ctx.Response
  try {
    $rel = [System.Uri]::UnescapeDataString($req.Url.AbsolutePath.TrimStart("/"))

    if ($rel -eq "api/130point") {
      $q = $req.QueryString["q"]
      if ([string]::IsNullOrWhiteSpace($q)) { Send-Text $res '{"error":"missing q"}' "application/json" 400 }
      elseif ($cache.ContainsKey($q) -and ((Get-Date) - $cache[$q].At).TotalMinutes -lt 45) {
        Send-Text $res $cache[$q].Html "text/html; charset=utf-8" 200   # served from cache: no hit on 130point
      }
      elseif ((Get-Date) -lt $script:limitUntil) {
        # 130point told us to stop until this time; answer locally so we do not extend the block
        $secs = [int][Math]::Ceiling(($script:limitUntil - (Get-Date)).TotalSeconds)
        $res.Headers.Add("Retry-After", "$secs")
        Send-Text $res ('{"error":"rate limited","retryAfter":' + $secs + '}') "application/json" 429
      }
      else {
        try {
          $wc = New-Object System.Net.WebClient
          $wc.Encoding = [System.Text.Encoding]::UTF8
          $wc.Headers["User-Agent"] = $UA
          $wc.Headers["Referer"] = "https://130point.com/sales/"
          $wc.Headers["Content-Type"] = "application/x-www-form-urlencoded"
          $body = "query=" + [System.Uri]::EscapeDataString($q)
          $html = $wc.UploadString("https://back.130point.com/sales/", $body)
          $cache[$q] = @{ At = (Get-Date); Html = $html }
          Send-Text $res $html "text/html; charset=utf-8" 200
        } catch {
          $msg = $_.Exception.Message
          $code = 502
          $secs = 0
          $resp = $null
          try { $resp = $_.Exception.InnerException.Response } catch {}
          if (-not $resp) { try { $resp = $_.Exception.Response } catch {} }
          if ($msg -match "429") {
            $code = 429
            $secs = 3600
            try { $ra = $resp.Headers["Retry-After"]; if ($ra) { $secs = [int]$ra } } catch {}
            $script:limitUntil = (Get-Date).AddSeconds($secs)
            $res.Headers.Add("Retry-After", "$secs")
            Write-Host ("130point rate limit: retry after {0}s (at {1:HH:mm})" -f $secs, $script:limitUntil)
          }
          Send-Text $res ('{"error":' + (ConvertTo-Json $msg) + ',"retryAfter":' + $secs + '}') "application/json" $code
        }
      }
    }
    elseif ($rel -eq "api/save" -and $req.HttpMethod -eq "POST") {
      $reader = New-Object System.IO.StreamReader($req.InputStream, $req.ContentEncoding)
      $text = $reader.ReadToEnd()
      $reader.Close()
      try {
        $null = ConvertFrom-Json $text   # validate before touching the file
        [System.IO.File]::WriteAllText((Join-Path $root "prizewall.json"), $text, (New-Object System.Text.UTF8Encoding($false)))
        Send-Text $res '{"ok":true}' "application/json" 200
        # publish the new data to GitHub in the background so the hosted copy follows the local sync
        if (Test-Path (Join-Path $root ".git")) {
          Start-Process powershell -WindowStyle Hidden -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-File",(Join-Path $root "publish.ps1"),"-NoSync"
        }
      } catch {
        Send-Text $res ('{"error":' + (ConvertTo-Json $_.Exception.Message) + '}') "application/json" 400
      }
    }
    else {
      if ([string]::IsNullOrWhiteSpace($rel)) { $rel = "index.html" }
      $path = Join-Path $root $rel
      if (Test-Path $path -PathType Leaf) {
        $ext = [System.IO.Path]::GetExtension($path).ToLower()
        $ct = $types[$ext]; if (-not $ct) { $ct = "application/octet-stream" }
        Send-Bytes $res ([System.IO.File]::ReadAllBytes($path)) $ct 200
      } else {
        Send-Text $res ("404: " + $rel) "text/plain" 404
      }
    }
  } catch {
    try { $res.StatusCode = 500 } catch {}
  } finally {
    try { $res.OutputStream.Close() } catch {}
  }
}
