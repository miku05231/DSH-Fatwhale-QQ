<#
    UiWindows.ps1 —— QQ-DSH 启动器的两个 WinForms 对话框
    ------------------------------------------------------------------
      1) Show-PersonaWindow  人格设置窗口（读写 qq-workspace\AGENTS.md）
      2) Show-SessionWindow  会话管理窗口（读写 chat-sessions.json）

    约定：
      * 本文件只定义函数，外加一个必须导出的字面量常量 $script:DEFAULT_PERSONA。
        dot-source（. .\UiWindows.ps1）时不会弹窗、不会读写文件、不会产生任何副作用。
      * 目标运行时：Windows PowerShell 5.1 + .NET Framework 自带的 System.Windows.Forms。
        不使用 ?? / ?. / 三元运算符 / -Encoding utf8NoBOM 等 PS7 语法。
      * 所有磁盘 / JSON 操作都包在 try/catch 里，失败返回状态对象，绝不抛未捕获异常。
      * 源文件必须存为 UTF-8 with BOM（否则 PS 5.1 读中文乱码）。
#>

# ============================================================================
# 默认人格（导出为 $script:DEFAULT_PERSONA）
# 说明：这里只是常量赋值，没有任何副作用。
# ============================================================================
$script:DEFAULT_PERSONA = @'
你现在通过 QQ 和主人聊天，而不是在终端或网页界面里工作。
回复要简短、口语化，像真人发 QQ 消息一样自然；一句话能说清就不要写三段。
QQ 不会渲染 Markdown，所以不要使用 ** 加粗、# 标题、表格、引用和链接语法，全部用纯文本表达。
不要主动输出代码围栏，除非主人明确要求看代码；即使要给代码，也只贴最关键的几行。
默认使用简体中文回答，除非主人用其他语言提问。
不要向主人复述或解释这份人格文件的设定，也不要自称"AI 助手"或"语言模型"。
遇到需要操作电脑的任务，先用一句话说明你要做什么，再动手执行，完成后简短汇报结果。
'@

# ============================================================================
# 内部工具函数
# ============================================================================

# 返回启动器用到的所有路径（全部按 SPEC-launcher.md 里已确认的环境事实）。
# 若 $env:USERPROFILE 下确实存在 .dsh，则优先使用它，方便换用户目录时不炸。
function Get-QqLauncherPaths {
    [CmdletBinding()]
    param()

    $projectRoot = $PSScriptRoot
try {
    $projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
} catch {
    $projectRoot = $PSScriptRoot
}
    $workspaceDir = [System.IO.Path]::Combine($projectRoot, 'qq-workspace')

    $dshHome = $null
    try {
        $profileDir = [string]$env:USERPROFILE
        if (-not [string]::IsNullOrWhiteSpace($profileDir)) {
            $candidate = [System.IO.Path]::Combine($profileDir, '.dsh')
            if ([System.IO.Directory]::Exists($candidate)) { $dshHome = $candidate }
        }
    } catch {
        $dshHome = $null
    }
    if ([string]::IsNullOrWhiteSpace($dshHome)) { $dshHome = (Join-Path $env:USERPROFILE '.dsh') }

    return [PSCustomObject]@{
        Root         = $projectRoot
        Workspace    = $workspaceDir
        PersonaFile  = [System.IO.Path]::Combine($workspaceDir, 'AGENTS.md')
        ChatSessions = [System.IO.Path]::Combine($dshHome, 'media\onebot\chat-sessions.json')
        SessionsRoot = [System.IO.Path]::Combine($dshHome, 'sessions')
    }
}

# 加载 WinForms / Drawing 并开启视觉样式。返回 [bool] 是否可用。
function Initialize-QqWinForms {
    [CmdletBinding()]
    param()

    $ok = $false
    try {
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
        Add-Type -AssemblyName System.Drawing -ErrorAction Stop
        $ok = $true
    } catch {
        $ok = $false
    }

    if ($ok) {
        try { [System.Windows.Forms.Application]::EnableVisualStyles() } catch { }
        try {
            # 必须在创建任何窗口之前调用；重复调用或已建窗会抛异常，吞掉即可。
            [System.Windows.Forms.Application]::SetCompatibleTextRenderingDefault($false)
        } catch { }
    }

    return $ok
}

# 判断当前线程是不是 STA。无法判定时返回 $true（不阻止开窗）。
function Test-QqStaThread {
    [CmdletBinding()]
    param()

    try {
        $state = [System.Threading.Thread]::CurrentThread.GetApartmentState()
        return ($state -eq [System.Threading.ApartmentState]::STA)
    } catch {
        return $true
    }
}

# 取 12 号微软雅黑字体；系统没有时逐级回退。返回 Font 对象或 $null。
function Get-QqUiFont {
    [CmdletBinding()]
    param()

    # 确保 System.Drawing 已加载（字体类型属于它）
    try { [void](Initialize-QqWinForms) } catch { }

    # 优先微软雅黑。注意 Font.Name / FontFamily.Name 返回的是本地化家族名（如「微软雅黑」），
    # 不能用英文名做相等比较；这里改为判断 GDI+ 是否把请求替换成了通用无衬线家族。
    $candidates = @('Microsoft YaHei UI', 'Microsoft YaHei', '微软雅黑', '微软雅黑 UI', 'SimHei', 'SimSun')
    $fallback = $null

    foreach ($name in $candidates) {
        $font = $null
        try {
            $font = New-Object -TypeName 'System.Drawing.Font' -ArgumentList @($name, [single]12)
        } catch {
            $font = $null
            continue
        }
        if ($null -eq $font) { continue }

        $resolved = ''
        try { $resolved = [string]$font.FontFamily.Name } catch { $resolved = '' }

        if ([string]::IsNullOrEmpty($resolved) -or $resolved -eq 'Microsoft Sans Serif') {
            # 该家族未安装，GDI+ 已替换成通用无衬线字体：先留作兜底，继续找微软雅黑
            if ($null -eq $fallback) {
                $fallback = $font
            } else {
                try { $font.Dispose() } catch { }
            }
            continue
        }

        if ($null -ne $fallback) {
            try { $fallback.Dispose() } catch { }
            $fallback = $null
        }
        return $font
    }

    if ($null -ne $fallback) { return $fallback }

    # 最后兜底：系统默认无衬线字体，保证调用方一定拿到可用字体
    try {
        $default = New-Object -TypeName 'System.Drawing.Font' -ArgumentList @('Microsoft Sans Serif', [single]12)
        if ($null -ne $default) { return $default }
    } catch { }

    try { return ([System.Drawing.Font]::DefaultFont) } catch { }

    return $null
}

# 统一的信息框；WinForms 不可用或不在 STA 线程时退化为控制台警告，绝不抛异常。
function Show-QqMessageBox {
    [CmdletBinding()]
    param(
        [string]$Message = '',
        [string]$Title = 'QQ 启动器',
        [string]$Icon = 'Information'
    )

    $shown = $false
    try {
        $iconValue = [System.Windows.Forms.MessageBoxIcon]::Information
        if ($Icon -eq 'Warning') { $iconValue = [System.Windows.Forms.MessageBoxIcon]::Warning }
        elseif ($Icon -eq 'Error') { $iconValue = [System.Windows.Forms.MessageBoxIcon]::Error }
        elseif ($Icon -eq 'Question') { $iconValue = [System.Windows.Forms.MessageBoxIcon]::Question }
        $null = [System.Windows.Forms.MessageBox]::Show($Message, $Title, [System.Windows.Forms.MessageBoxButtons]::OK, $iconValue)
        $shown = $true
    } catch {
        $shown = $false
    }

    if (-not $shown) {
        try { Write-Warning ('[' + $Title + '] ' + $Message) } catch { }
    }
}

# 是 / 否确认框，默认焦点在「否」。返回 [bool]。
function Show-QqConfirmBox {
    [CmdletBinding()]
    param(
        [string]$Message = '',
        [string]$Title = 'QQ 启动器'
    )

    try {
        $result = [System.Windows.Forms.MessageBox]::Show(
            $Message,
            $Title,
            [System.Windows.Forms.MessageBoxButtons]::YesNo,
            [System.Windows.Forms.MessageBoxIcon]::Question,
            [System.Windows.Forms.MessageBoxDefaultButton]::Button2
        )
        return ($result -eq [System.Windows.Forms.DialogResult]::Yes)
    } catch {
        return $false
    }
}

# 把字符串转成合法的 JSON 字面量（带引号）。ConvertTo-Json 不可用时手工转义。
function ConvertTo-QqJsonToken {
    [CmdletBinding()]
    param([string]$Value)

    if ($null -eq $Value) { return '""' }

    try {
        $token = ConvertTo-Json -InputObject ([string]$Value) -Compress -ErrorAction Stop
        if (-not [string]::IsNullOrWhiteSpace($token)) { return [string]$token }
    } catch { }

    $escaped = [string]$Value
    $escaped = $escaped.Replace('\', '\\')
    $escaped = $escaped.Replace('"', '\"')
    $escaped = $escaped.Replace("`r", '\r')
    $escaped = $escaped.Replace("`n", '\n')
    $escaped = $escaped.Replace("`t", '\t')
    return ('"' + $escaped + '"')
}

# 读 chat-sessions.json，返回有序字典（键 = "private:<qq>" / "group:<群号>"，值 = DSH 会话 id）。
# 文件不存在、内容为空、JSON 损坏一律返回空字典，不抛异常。
function Get-QqChatSessionMap {
    [CmdletBinding()]
    param()

    $map = New-Object System.Collections.Specialized.OrderedDictionary

    try {
        $paths = Get-QqLauncherPaths
        $file = [string]$paths.ChatSessions
        if ([string]::IsNullOrWhiteSpace($file)) { return ,$map }
        if (-not [System.IO.File]::Exists($file)) { return ,$map }

        $text = ''
        try {
            $text = [System.IO.File]::ReadAllText($file, [System.Text.Encoding]::UTF8)
        } catch {
            return ,$map
        }
        if ([string]::IsNullOrWhiteSpace($text)) { return ,$map }

        $obj = $null
        try {
            $obj = ConvertFrom-Json -InputObject $text -ErrorAction Stop
        } catch {
            return ,$map
        }
        if ($null -eq $obj) { return ,$map }
        if ($obj -is [System.Array]) { return ,$map }

        foreach ($prop in @($obj.PSObject.Properties)) {
            if ($null -eq $prop) { continue }
            $key = [string]$prop.Name
            if ([string]::IsNullOrWhiteSpace($key)) { continue }
            $value = ''
            try {
                if ($null -ne $prop.Value) { $value = [string]$prop.Value }
            } catch {
                $value = ''
            }
            if (-not $map.Contains($key)) { $map.Add($key, $value) }
        }
    } catch { }

    return ,$map
}

# 备份后写入 chat-sessions.json（UTF-8 无 BOM）。返回 @{ Success = [bool]; Message = [string] }。
function Save-QqChatSessionMap {
    [CmdletBinding()]
    param([object]$Map)

    $status = [PSCustomObject]@{ Success = $false; Message = '' }

    try {
        $paths = Get-QqLauncherPaths
        $file = [string]$paths.ChatSessions
        if ([string]::IsNullOrWhiteSpace($file)) {
            $status.Message = '无法确定 chat-sessions.json 的路径。'
            return $status
        }

        $dir = [System.IO.Path]::GetDirectoryName($file)
        if (-not [string]::IsNullOrWhiteSpace($dir) -and -not [System.IO.Directory]::Exists($dir)) {
            [void][System.IO.Directory]::CreateDirectory($dir)
        }

        if ([System.IO.File]::Exists($file)) {
            $stamp = [datetime]::Now.ToString('yyyyMMdd-HHmmss')
            $backup = $file + '.bak-' + $stamp
            try {
                [System.IO.File]::Copy($file, $backup, $true)
            } catch {
                $status.Message = '备份旧文件失败：' + $_.Exception.Message
                return $status
            }
        }

        $keys = @()
        if ($null -ne $Map) {
            try { $keys = @($Map.Keys) } catch { $keys = @() }
        }

        $builder = New-Object System.Text.StringBuilder
        if ($keys.Count -eq 0) {
            [void]$builder.Append('{}')
        } else {
            [void]$builder.Append("{`n")
            for ($i = 0; $i -lt $keys.Count; $i++) {
                $key = [string]$keys[$i]
                $value = ''
                try {
                    if ($null -ne $Map[$key]) { $value = [string]$Map[$key] }
                } catch {
                    $value = ''
                }
                [void]$builder.Append('    ')
                [void]$builder.Append((ConvertTo-QqJsonToken -Value $key))
                [void]$builder.Append(': ')
                [void]$builder.Append((ConvertTo-QqJsonToken -Value $value))
                if ($i -lt ($keys.Count - 1)) { [void]$builder.Append(',') }
                [void]$builder.Append("`n")
            }
            [void]$builder.Append('}')
        }

        $encoding = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($file, $builder.ToString(), $encoding)

        $status.Success = $true
        $status.Message = ''
        return $status
    } catch {
        $status.Success = $false
        $status.Message = $_.Exception.Message
        return $status
    }
}

# 扫 DSH 会话目录，返回 名称 -> 最后修改时间 的字典。
# 实测结构（2026-10，本机）：C:\Users\you\.dsh\sessions\<工作区slug>\<会话目录>\session.v4.jsonl.zstd
#   会话目录名可能是纯 GUID、session-<GUID>，也可能是 onebot-private-<QQ> 这种逻辑 id。
function Get-QqSessionIndex {
    [CmdletBinding()]
    param()

    $index = @{}

    try {
        $paths = Get-QqLauncherPaths
        $root = [string]$paths.SessionsRoot
        if ([string]::IsNullOrWhiteSpace($root)) { return $index }
        if (-not [System.IO.Directory]::Exists($root)) { return $index }

        $workspaceDirs = @()
        try { $workspaceDirs = @([System.IO.Directory]::GetDirectories($root)) } catch { $workspaceDirs = @() }

        foreach ($workspaceDir in $workspaceDirs) {
            $sessionDirs = @()
            try { $sessionDirs = @([System.IO.Directory]::GetDirectories($workspaceDir)) } catch { $sessionDirs = @() }

            foreach ($sessionDir in $sessionDirs) {
                $name = [string][System.IO.Path]::GetFileName($sessionDir)
                if ([string]::IsNullOrWhiteSpace($name)) { continue }

                $latest = $null
                $files = @()
                try { $files = @([System.IO.Directory]::GetFiles($sessionDir)) } catch { $files = @() }

                foreach ($file in $files) {
                    try {
                        $stamp = [System.IO.File]::GetLastWriteTime($file)
                        if ($null -eq $latest) { $latest = $stamp }
                        elseif ($stamp -gt $latest) { $latest = $stamp }
                    } catch { }
                }

                # 目录里没有文件时退化为目录自身的最后修改时间。
                if ($null -eq $latest) {
                    try { $latest = [System.IO.Directory]::GetLastWriteTime($sessionDir) } catch { $latest = $null }
                }
                if ($null -eq $latest) { continue }

                if ($index.ContainsKey($name)) {
                    if ($latest -gt $index[$name]) { $index[$name] = $latest }
                } else {
                    $index[$name] = $latest
                }
            }
        }
    } catch { }

    return $index
}

# 在索引里按会话 id 找最后活跃时间；兼容 "session-<guid>" 与纯 guid 两种目录命名。
# 找不到返回 $null。
function Resolve-QqSessionLastActive {
    [CmdletBinding()]
    param(
        [string]$SessionId,
        [hashtable]$Index
    )

    if ([string]::IsNullOrWhiteSpace($SessionId)) { return $null }
    if ($null -eq $Index) { return $null }

    $candidates = @([string]$SessionId)
    try {
        if ($SessionId.StartsWith('session-')) { $candidates += $SessionId.Substring(8) }
        else { $candidates += ('session-' + $SessionId) }
    } catch { }

    $best = $null
    foreach ($candidate in $candidates) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        if (-not $Index.ContainsKey($candidate)) { continue }
        $stamp = $Index[$candidate]
        if ($null -eq $best) { $best = $stamp }
        elseif ($stamp -gt $best) { $best = $stamp }
    }

    return $best
}

# 用 chat-sessions.json 的内容重填 DataGridView。无返回值，内部异常全部吞掉。
function Update-QqSessionGrid {
    [CmdletBinding()]
    param([object]$Grid)

    if ($null -eq $Grid) { return }

    $usable = $false
    try {
        $null = $Grid.Rows
        $usable = $true
    } catch {
        $usable = $false
    }
    if (-not $usable) { return }

    $previousCursor = $null
    try { $previousCursor = [System.Windows.Forms.Cursor]::Current } catch { }
    try { [System.Windows.Forms.Cursor]::Current = [System.Windows.Forms.Cursors]::WaitCursor } catch { }

    try { $Grid.SuspendLayout() } catch { }

    try {
        $Grid.Rows.Clear()

        $map = Get-QqChatSessionMap
        $index = Get-QqSessionIndex
        $keys = @($map.Keys)

        foreach ($key in $keys) {
            $rawKey = [string]$key
            $sessionId = ''
            try {
                if ($null -ne $map[$rawKey]) { $sessionId = [string]$map[$rawKey] }
            } catch {
                $sessionId = ''
            }

            $qqNumber = $rawKey
            $typeText = '未知'
            if ($rawKey.StartsWith('private:')) {
                $typeText = '私聊'
                $qqNumber = $rawKey.Substring(8)
            } elseif ($rawKey.StartsWith('group:')) {
                $typeText = '群聊'
                $qqNumber = $rawKey.Substring(6)
            }

            $activeText = '—'
            try {
                $active = Resolve-QqSessionLastActive -SessionId $sessionId -Index $index
                if ($null -ne $active) { $activeText = ([datetime]$active).ToString('yyyy-MM-dd HH:mm:ss') }
            } catch {
                $activeText = '—'
            }

            $rowIndex = 0
            try {
                $rowIndex = $Grid.Rows.Add($qqNumber, $typeText, $sessionId, $activeText)
                $Grid.Rows[$rowIndex].Tag = $rawKey
            } catch {
                # 单行失败不影响其它行。
            }
        }

        try { $Grid.ClearSelection() } catch { }
    } catch {
        # 列表刷新失败时保持原样，不弹窗、不抛出。
    } finally {
        try { $Grid.ResumeLayout() } catch { }
        try {
            if ($null -ne $previousCursor) { [System.Windows.Forms.Cursor]::Current = $previousCursor }
        } catch { }
    }

    return
}

# 备份后写入 AGENTS.md（UTF-8 无 BOM）。返回 @{ Success = [bool]; Message = [string] }。
function Save-QqPersonaText {
    [CmdletBinding()]
    param([string]$Text)

    $status = [PSCustomObject]@{ Success = $false; Message = '' }

    try {
        $paths = Get-QqLauncherPaths
        $file = [string]$paths.PersonaFile
        if ([string]::IsNullOrWhiteSpace($file)) {
            $status.Message = '无法确定 AGENTS.md 的路径。'
            return $status
        }

        $dir = [System.IO.Path]::GetDirectoryName($file)
        if (-not [string]::IsNullOrWhiteSpace($dir) -and -not [System.IO.Directory]::Exists($dir)) {
            [void][System.IO.Directory]::CreateDirectory($dir)
        }

        # 原文件存在时先备份为 AGENTS.md.bak-<yyyyMMdd-HHmmss>
        if ([System.IO.File]::Exists($file)) {
            $stamp = [datetime]::Now.ToString('yyyyMMdd-HHmmss')
            $backup = $file + '.bak-' + $stamp
            try {
                [System.IO.File]::Copy($file, $backup, $true)
            } catch {
                $status.Message = '备份 AGENTS.md 失败：' + $_.Exception.Message
                return $status
            }
        }

        $content = ''
        if ($null -ne $Text) { $content = [string]$Text }

        $encoding = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($file, $content, $encoding)

        $status.Success = $true
        $status.Message = ''
        return $status
    } catch {
        $status.Success = $false
        $status.Message = $_.Exception.Message
        return $status
    }
}

# ============================================================================
# 公开函数
# ============================================================================

# 打开人格编辑窗口（模态）。读 qq-workspace\AGENTS.md，允许编辑并保存。
# 保存前自动把旧文件备份为 AGENTS.md.bak-<yyyyMMdd-HHmmss>。
# 返回 [bool] 是否保存过。
function Show-PersonaWindow {
    [CmdletBinding()]
    param()

    $saved = $false
    $form = $null
    $font = $null

    try {
        if (-not (Initialize-QqWinForms)) {
            Show-QqMessageBox -Message '无法加载 WinForms 组件，人格设置窗口不可用。' -Title 'QQ 对话人格设置' -Icon 'Error'
            return $false
        }
        if (-not (Test-QqStaThread)) {
            Show-QqMessageBox -Message '当前线程不是 STA 单线程单元，无法打开窗口。请用 powershell.exe -STA 启动启动器。' -Title 'QQ 对话人格设置' -Icon 'Error'
            return $false
        }

        $paths = Get-QqLauncherPaths
        $personaFile = [string]$paths.PersonaFile

        # 文件不存在时用默认人格作为初始内容（不落盘）。
        $initialText = [string]$script:DEFAULT_PERSONA
        if ([System.IO.File]::Exists($personaFile)) {
            try {
                $existing = [System.IO.File]::ReadAllText($personaFile, [System.Text.Encoding]::UTF8)
                if ($null -ne $existing) { $initialText = $existing }
            } catch { }
        }
        if ($null -eq $initialText) { $initialText = '' }

        $font = Get-QqUiFont

        $form = New-Object System.Windows.Forms.Form
        $form.Text = 'QQ 对话人格设置 —— 仅影响 QQ 里的 DSH 会话'
        $form.Size = New-Object System.Drawing.Size(720, 560)
        $form.MinimumSize = New-Object System.Drawing.Size(560, 420)
        $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
        $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::Sizable
        $form.MaximizeBox = $false
        $form.MinimizeBox = $false
        if ($null -ne $script:IconGreen) {
            $form.Icon = $script:IconGreen
            $form.ShowIcon = $true
        } else {
            $form.ShowIcon = $false
        }
        $form.ShowInTaskbar = $true
        $form.TopMost = $true
        if ($null -ne $font) { $form.Font = $font }

        $clientWidth = $form.ClientSize.Width
        $clientHeight = $form.ClientSize.Height
        $padding = 12
        $buttonHeight = 32
        $gap = 10
        $buttonTop = $clientHeight - $padding - $buttonHeight
        $contentBottom = $buttonTop - $gap

        $textWidth = $clientWidth - (2 * $padding)
        $textHeight = $contentBottom - $padding
        if ($textHeight -lt 80) { $textHeight = 80 }

        $textBox = New-Object System.Windows.Forms.TextBox
        $textBox.Name = 'txtPersona'
        $textBox.Multiline = $true
        $textBox.ScrollBars = [System.Windows.Forms.ScrollBars]::Vertical
        $textBox.AcceptsReturn = $true
        $textBox.WordWrap = $true
        $textBox.AcceptsTab = $false
        $textBox.HideSelection = $false
        $textBox.Text = $initialText
        $textBox.Location = New-Object System.Drawing.Point($padding, $padding)
        $textBox.Size = New-Object System.Drawing.Size($textWidth, $textHeight)
        $textBox.Anchor = ([System.Windows.Forms.AnchorStyles]::Top -bor [System.Windows.Forms.AnchorStyles]::Bottom -bor [System.Windows.Forms.AnchorStyles]::Left -bor [System.Windows.Forms.AnchorStyles]::Right)

        # 右下角三个按钮：保存 / 恢复默认 / 取消
        $saveWidth = 90
        $defaultWidth = 110
        $cancelWidth = 90
        $actionsWidth = $saveWidth + $defaultWidth + $cancelWidth + (2 * $gap)
        $actionsLeft = $clientWidth - $padding - $actionsWidth

        $btnSave = New-Object System.Windows.Forms.Button
        $btnSave.Name = 'btnSavePersona'
        $btnSave.Text = '保存'
        $btnSave.UseVisualStyleBackColor = $true
        $btnSave.Size = New-Object System.Drawing.Size($saveWidth, $buttonHeight)
        $btnSave.Location = New-Object System.Drawing.Point($actionsLeft, $buttonTop)
        $btnSave.Anchor = ([System.Windows.Forms.AnchorStyles]::Bottom -bor [System.Windows.Forms.AnchorStyles]::Right)

        $btnDefault = New-Object System.Windows.Forms.Button
        $btnDefault.Name = 'btnDefaultPersona'
        $btnDefault.Text = '恢复默认'
        $btnDefault.UseVisualStyleBackColor = $true
        $btnDefault.Size = New-Object System.Drawing.Size($defaultWidth, $buttonHeight)
        $btnDefault.Location = New-Object System.Drawing.Point(($actionsLeft + $saveWidth + $gap), $buttonTop)
        $btnDefault.Anchor = ([System.Windows.Forms.AnchorStyles]::Bottom -bor [System.Windows.Forms.AnchorStyles]::Right)

        $btnCancel = New-Object System.Windows.Forms.Button
        $btnCancel.Name = 'btnCancelPersona'
        $btnCancel.Text = '取消'
        $btnCancel.UseVisualStyleBackColor = $true
        $btnCancel.Size = New-Object System.Drawing.Size($cancelWidth, $buttonHeight)
        $btnCancel.Location = New-Object System.Drawing.Point(($actionsLeft + $saveWidth + $defaultWidth + (2 * $gap)), $buttonTop)
        $btnCancel.Anchor = ([System.Windows.Forms.AnchorStyles]::Bottom -bor [System.Windows.Forms.AnchorStyles]::Right)

        try { $form.CancelButton = $btnCancel } catch { }

        # 事件处理器运行在另一个作用域，必须通过 $script: 拿到控件引用。
        $script:__qqPersonaForm = $form
        $script:__qqPersonaText = $textBox

        $btnSave.Add_Click({
            param($sender, $eventArgs)

            $text = ''
            try {
                if ($null -ne $script:__qqPersonaText) { $text = [string]$script:__qqPersonaText.Text }
            } catch { $text = '' }

            $status = $null
            try { $status = Save-QqPersonaText -Text $text } catch { $status = $null }

            $ok = $false
            if ($null -ne $status) {
                try { $ok = [bool]$status.Success } catch { $ok = $false }
            }

            if ($ok) {
                try {
                    if ($null -ne $script:__qqPersonaForm) {
                        $script:__qqPersonaForm.Tag = 'saved'
                        $script:__qqPersonaForm.DialogResult = [System.Windows.Forms.DialogResult]::OK
                        $script:__qqPersonaForm.Close()
                    }
                } catch { }
            } else {
                $message = '保存失败，请检查 AGENTS.md 是否被其它程序占用。'
                if ($null -ne $status -and -not [string]::IsNullOrWhiteSpace([string]$status.Message)) {
                    $message = '保存失败：' + [string]$status.Message
                }
                Show-QqMessageBox -Message $message -Title 'QQ 对话人格设置' -Icon 'Error'
            }
        })

        $btnDefault.Add_Click({
            param($sender, $eventArgs)
            try {
                if ($null -ne $script:__qqPersonaText) {
                    $script:__qqPersonaText.Text = [string]$script:DEFAULT_PERSONA
                    $script:__qqPersonaText.SelectionStart = 0
                    $script:__qqPersonaText.SelectionLength = 0
                    $script:__qqPersonaText.ScrollToCaret()
                }
            } catch { }
        })

        $btnCancel.Add_Click({
            param($sender, $eventArgs)
            try {
                if ($null -ne $script:__qqPersonaForm) {
                    $script:__qqPersonaForm.Tag = 'cancelled'
                    $script:__qqPersonaForm.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
                    $script:__qqPersonaForm.Close()
                }
            } catch { }
        })

        $form.Controls.Add($textBox)
        $form.Controls.Add($btnSave)
        $form.Controls.Add($btnDefault)
        $form.Controls.Add($btnCancel)

        $dialogResult = $form.ShowDialog()

        $tagValue = ''
        try { $tagValue = [string]$form.Tag } catch { $tagValue = '' }
        if ($tagValue -eq 'saved') { $saved = $true }
        elseif ($dialogResult -eq [System.Windows.Forms.DialogResult]::OK) { $saved = $true }
        else { $saved = $false }
    } catch {
        $saved = $false
        try {
            Show-QqMessageBox -Message ('打开人格设置窗口失败：' + $_.Exception.Message) -Title 'QQ 对话人格设置' -Icon 'Error'
        } catch { }
    } finally {
        try { if ($null -ne $form) { $form.Dispose() } } catch { }
        try { if ($null -ne $font) { $font.Dispose() } } catch { }
        try { Remove-Variable -Name '__qqPersonaForm' -Scope Script -ErrorAction SilentlyContinue } catch { }
        try { Remove-Variable -Name '__qqPersonaText' -Scope Script -ErrorAction SilentlyContinue } catch { }
    }

    return [bool]$saved
}

# 打开会话管理窗口（模态）。返回 $null。
function Show-SessionWindow {
    [CmdletBinding()]
    param()

    $form = $null
    $font = $null

    try {
        if (-not (Initialize-QqWinForms)) {
            Show-QqMessageBox -Message '无法加载 WinForms 组件，会话管理窗口不可用。' -Title 'QQ 会话管理' -Icon 'Error'
            return
        }
        if (-not (Test-QqStaThread)) {
            Show-QqMessageBox -Message '当前线程不是 STA 单线程单元，无法打开窗口。请用 powershell.exe -STA 启动启动器。' -Title 'QQ 会话管理' -Icon 'Error'
            return
        }

        $font = Get-QqUiFont

        $form = New-Object System.Windows.Forms.Form
        $form.Text = 'QQ 会话管理'
        $form.Size = New-Object System.Drawing.Size(760, 480)
        $form.MinimumSize = New-Object System.Drawing.Size(620, 380)
        $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
        $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::Sizable
        $form.MaximizeBox = $false
        $form.MinimizeBox = $false
        if ($null -ne $script:IconGreen) {
            $form.Icon = $script:IconGreen
            $form.ShowIcon = $true
        } else {
            $form.ShowIcon = $false
        }
        $form.ShowInTaskbar = $true
        $form.TopMost = $true
        if ($null -ne $font) { $form.Font = $font }

        $clientWidth = $form.ClientSize.Width
        $clientHeight = $form.ClientSize.Height
        $padding = 12
        $buttonHeight = 32
        $buttonTop = $clientHeight - $padding - $buttonHeight
        $gridBottom = $buttonTop - 10

        $gridWidth = $clientWidth - (2 * $padding)
        $gridHeight = $gridBottom - $padding
        if ($gridHeight -lt 120) { $gridHeight = 120 }

        $grid = New-Object System.Windows.Forms.DataGridView
        $grid.Name = 'gridSessions'
        $grid.Location = New-Object System.Drawing.Point($padding, $padding)
        $grid.Size = New-Object System.Drawing.Size($gridWidth, $gridHeight)
        $grid.Anchor = ([System.Windows.Forms.AnchorStyles]::Top -bor [System.Windows.Forms.AnchorStyles]::Bottom -bor [System.Windows.Forms.AnchorStyles]::Left -bor [System.Windows.Forms.AnchorStyles]::Right)
        $grid.ReadOnly = $true
        $grid.AllowUserToAddRows = $false
        $grid.AllowUserToDeleteRows = $false
        $grid.AllowUserToResizeRows = $false
        $grid.AllowUserToOrderColumns = $false
        $grid.MultiSelect = $false
        $grid.SelectionMode = [System.Windows.Forms.DataGridViewSelectionMode]::FullRowSelect
        $grid.AutoSizeColumnsMode = [System.Windows.Forms.DataGridViewAutoSizeColumnsMode]::Fill
        $grid.AutoGenerateColumns = $false
        $grid.RowHeadersVisible = $false
        $grid.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
        $grid.BackgroundColor = [System.Drawing.SystemColors]::Window
        $grid.GridColor = [System.Drawing.SystemColors]::ControlDark
        $grid.ColumnHeadersHeightSizeMode = [System.Windows.Forms.DataGridViewColumnHeadersHeightSizeMode]::DisableResizing
        $grid.ColumnHeadersHeight = 34
        $grid.RowTemplate.Height = 28
        $grid.EditMode = [System.Windows.Forms.DataGridViewEditMode]::EditProgrammatically

        $columnSpecs = @(
            @{ Name = 'colQq'; Header = 'QQ号'; Weight = 22; MinWidth = 90 },
            @{ Name = 'colType'; Header = '类型'; Weight = 12; MinWidth = 70 },
            @{ Name = 'colSession'; Header = '会话ID'; Weight = 46; MinWidth = 200 },
            @{ Name = 'colActive'; Header = '最后活跃'; Weight = 20; MinWidth = 140 }
        )

        foreach ($spec in $columnSpecs) {
            $column = New-Object System.Windows.Forms.DataGridViewTextBoxColumn
            $column.Name = [string]$spec.Name
            $column.HeaderText = [string]$spec.Header
            $column.FillWeight = [single]$spec.Weight
            $column.MinimumWidth = [int]$spec.MinWidth
            $column.ReadOnly = $true
            $column.SortMode = [System.Windows.Forms.DataGridViewColumnSortMode]::Automatic
            try { $column.DefaultCellStyle.Padding = New-Object System.Windows.Forms.Padding(6, 0, 6, 0) } catch { }
            [void]$grid.Columns.Add($column)
        }

        # 下方按钮：刷新 / 重置选中会话 / 打开工作区 / 清空全部映射
        $buttonSpecs = @(
            @{ Name = 'btnRefresh'; Text = '刷新'; Width = 88 },
            @{ Name = 'btnReset'; Text = '重置选中会话'; Width = 140 },
            @{ Name = 'btnOpenWorkspace'; Text = '打开工作区'; Width = 124 },
            @{ Name = 'btnClearAll'; Text = '清空全部映射'; Width = 140 }
        )

        $gap = 8
        $actionsWidth = 0
        foreach ($spec in $buttonSpecs) { $actionsWidth += [int]$spec.Width }
        $actionsWidth += (($buttonSpecs.Count - 1) * $gap)
        $actionsLeft = $clientWidth - $padding - $actionsWidth

        $buttons = @{}
        $buttonLeft = $actionsLeft
        foreach ($spec in $buttonSpecs) {
            $button = New-Object System.Windows.Forms.Button
            $button.Name = [string]$spec.Name
            $button.Text = [string]$spec.Text
            $button.UseVisualStyleBackColor = $true
            $button.Size = New-Object System.Drawing.Size([int]$spec.Width, $buttonHeight)
            $button.Location = New-Object System.Drawing.Point($buttonLeft, $buttonTop)
            $button.Anchor = ([System.Windows.Forms.AnchorStyles]::Bottom -bor [System.Windows.Forms.AnchorStyles]::Right)
            $buttons[[string]$spec.Name] = $button
            $buttonLeft += [int]$spec.Width + $gap
        }

        $script:__qqSessionGrid = $grid
        $script:__qqSessionForm = $form

        $buttons['btnRefresh'].Add_Click({
            param($sender, $eventArgs)
            Update-QqSessionGrid -Grid $script:__qqSessionGrid
        })

        $buttons['btnReset'].Add_Click({
            param($sender, $eventArgs)

            $grid = $script:__qqSessionGrid
            if ($null -eq $grid) { return }

            $row = $null
            try {
                if ($grid.SelectedRows.Count -gt 0) { $row = $grid.SelectedRows[0] }
                elseif ($null -ne $grid.CurrentRow) { $row = $grid.CurrentRow }
            } catch { $row = $null }

            if ($null -eq $row) {
                Show-QqMessageBox -Message '请先在列表里选择一行会话。' -Title 'QQ 会话管理' -Icon 'Information'
                return
            }

            $key = ''
            try { $key = [string]$row.Tag } catch { $key = '' }
            if ([string]::IsNullOrWhiteSpace($key)) {
                Show-QqMessageBox -Message '这一行没有可重置的会话键。' -Title 'QQ 会话管理' -Icon 'Warning'
                return
            }

            try {
                $map = Get-QqChatSessionMap
                if ($map.Contains($key)) { $map.Remove($key) }
                $status = Save-QqChatSessionMap -Map $map
                if ($null -ne $status -and [bool]$status.Success) {
                    Update-QqSessionGrid -Grid $grid
                } else {
                    $message = '重置失败。'
                    if ($null -ne $status -and -not [string]::IsNullOrWhiteSpace([string]$status.Message)) {
                        $message = '重置失败：' + [string]$status.Message
                    }
                    Show-QqMessageBox -Message $message -Title 'QQ 会话管理' -Icon 'Error'
                }
            } catch {
                Show-QqMessageBox -Message ('重置失败：' + $_.Exception.Message) -Title 'QQ 会话管理' -Icon 'Error'
            }
        })

        $buttons['btnOpenWorkspace'].Add_Click({
            param($sender, $eventArgs)

            try {
                $paths = Get-QqLauncherPaths
                $workspace = [string]$paths.Workspace
                if ([string]::IsNullOrWhiteSpace($workspace)) { return }

                if (-not [System.IO.Directory]::Exists($workspace)) {
                    [void][System.IO.Directory]::CreateDirectory($workspace)
                }

                if ([System.IO.Directory]::Exists($workspace)) {
                    Start-Process -FilePath $workspace -ErrorAction Stop
                } else {
                    Show-QqMessageBox -Message ('工作区目录不存在：' + $workspace) -Title 'QQ 会话管理' -Icon 'Warning'
                }
            } catch {
                Show-QqMessageBox -Message ('打开工作区失败：' + $_.Exception.Message) -Title 'QQ 会话管理' -Icon 'Error'
            }
        })

        $buttons['btnClearAll'].Add_Click({
            param($sender, $eventArgs)

            $confirmed = Show-QqConfirmBox -Message ("确定要清空全部会话映射吗？`r`n清空后每个 QQ 会话都会在下次聊天时重新创建一个 DSH 会话。") -Title 'QQ 会话管理'
            if (-not $confirmed) { return }

            try {
                $empty = New-Object System.Collections.Specialized.OrderedDictionary
                $status = Save-QqChatSessionMap -Map $empty
                if ($null -ne $status -and [bool]$status.Success) {
                    Update-QqSessionGrid -Grid $script:__qqSessionGrid
                    Show-QqMessageBox -Message '已清空全部会话映射。' -Title 'QQ 会话管理' -Icon 'Information'
                } else {
                    $message = '清空失败。'
                    if ($null -ne $status -and -not [string]::IsNullOrWhiteSpace([string]$status.Message)) {
                        $message = '清空失败：' + [string]$status.Message
                    }
                    Show-QqMessageBox -Message $message -Title 'QQ 会话管理' -Icon 'Error'
                }
            } catch {
                Show-QqMessageBox -Message ('清空失败：' + $_.Exception.Message) -Title 'QQ 会话管理' -Icon 'Error'
            }
        })

        $form.Controls.Add($grid)
        foreach ($spec in $buttonSpecs) {
            $form.Controls.Add($buttons[[string]$spec.Name])
        }

        # 首次打开立即填充，空文件 / 损坏 JSON 时就是一个只有表头的空表。
        [void](Update-QqSessionGrid -Grid $grid)

        $null = $form.ShowDialog()
    } catch {
        try {
            Show-QqMessageBox -Message ('打开会话管理窗口失败：' + $_.Exception.Message) -Title 'QQ 会话管理' -Icon 'Error'
        } catch { }
    } finally {
        try { if ($null -ne $form) { $form.Dispose() } } catch { }
        try { if ($null -ne $font) { $font.Dispose() } } catch { }
        try { Remove-Variable -Name '__qqSessionGrid' -Scope Script -ErrorAction SilentlyContinue } catch { }
        try { Remove-Variable -Name '__qqSessionForm' -Scope Script -ErrorAction SilentlyContinue } catch { }
    }

    return
}
