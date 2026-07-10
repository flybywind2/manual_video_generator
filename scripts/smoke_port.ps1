function Get-ProcessTreeIds {
    param([Parameter(Mandatory = $true)][int]$RootProcessId)

    $processes = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
    $pending = [System.Collections.Generic.Queue[int]]::new()
    $seen = [System.Collections.Generic.HashSet[int]]::new()
    $pending.Enqueue($RootProcessId)
    while ($pending.Count -gt 0) {
        $processId = $pending.Dequeue()
        if (-not $seen.Add($processId)) { continue }
        foreach ($child in $processes | Where-Object { $_.ParentProcessId -eq $processId }) {
            $pending.Enqueue([int]$child.ProcessId)
        }
    }
    return @($seen)
}

function Get-LoopbackPortOwnerProcessIds {
    param([Parameter(Mandatory = $true)][int]$Port)

    $connections = @(
        Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
            Where-Object { $_.LocalAddress -in @("127.0.0.1", "0.0.0.0", "::", "::1") }
    )
    $exactLoopback = @($connections | Where-Object { $_.LocalAddress -eq "127.0.0.1" })
    $relevant = if ($exactLoopback.Count -gt 0) { $exactLoopback } else { $connections }
    return @($relevant | Select-Object -ExpandProperty OwningProcess -Unique)
}

function Test-PortOwnedByProcessTree {
    param(
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][int]$RootProcessId
    )

    $owners = @(Get-LoopbackPortOwnerProcessIds -Port $Port)
    if ($owners.Count -eq 0) { return $false }
    $processTree = @(Get-ProcessTreeIds -RootProcessId $RootProcessId)
    foreach ($owner in $owners) {
        if ($owner -notin $processTree) { return $false }
    }
    return $true
}
