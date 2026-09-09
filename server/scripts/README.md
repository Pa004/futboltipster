# Relay diario EC1 (automatización local)

`relay-ec1.ps1` levanta ml-service y server solo si están caídos y espera a que
el `tick()` de arranque complete el sync ESPN + push a `/ingest`. Sin argumentos.

## Tarea programada (una vez, terminal como administrador)

```powershell
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument '-NoProfile -ExecutionPolicy Bypass -File "C:\Users\Asus\Desktop\futbol-predictor\server\scripts\relay-ec1.ps1"'
$t1 = New-ScheduledTaskTrigger -Daily -At "06:05"
$t2 = New-ScheduledTaskTrigger -AtLogOn
$set = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable
Register-ScheduledTask -TaskName "FutbolTipsterRelay" -Action $action -Trigger @($t1, $t2) -Settings $set -Description "Relay diario EC1 a Cloudflare"
```

Ajusta la ruta `-File` si el repo no está en esa ubicación.

Alternativa sin terminal: Task Scheduler → Create Task → Triggers (Daily 06:05 + At log on) → Action (powershell.exe con los mismos argumentos) → Conditions (✓ Wake the computer to run this task) → Settings (✓ Run task as soon as possible after a scheduled start is missed).

## Verificación

```powershell
Start-ScheduledTask -TaskName "FutbolTipsterRelay"   # requiere la tarea registrada
Get-Content "$env:LOCALAPPDATA\Temp\opencode\server-relay-*.log" | Select-Object -Last 3
cd ..\..\worker
npx wrangler d1 execute futboltipster --remote --command "SELECT COUNT(*) AS n FROM fixtures WHERE league='EC1'"
```

## Límites honestos

PC totalmente apagado varios días = sin relay (cloud sirve últimos datos con fecha visible). Suspensión con wake timers sí despierta para la tarea de las 06:05.
