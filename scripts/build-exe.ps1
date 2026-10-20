# ============================================================
#  build-exe.ps1 —— 编译「本地 exe」入口（不联网、不装任何依赖）
#
#  产物：dist\qq-bridge.exe
#  行为：双击 = 起服务（等价 node tools\cli.mjs start）+ 打开控制台
#        带参数 = 原样转给 tools\cli.mjs，例如
#            qq-bridge.exe status
#            qq-bridge.exe stop
#            qq-bridge.exe logs bridge --lines 100
#
#  编译器用 Windows 自带的 .NET Framework csc.exe（Win10/11 都有），
#  所以不需要 dotnet SDK、不需要 npm。
# ============================================================
[CmdletBinding()]
param(
    [string]$OutputPath = '',
    [switch]$KeepSource
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = [IO.Path]::GetFullPath((Join-Path $scriptDir '..'))

if (-not $OutputPath) { $OutputPath = Join-Path $root 'dist\qq-bridge.exe' }
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
$outDir = Split-Path -Parent $OutputPath
if (-not (Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }

# ---- 找 csc.exe ----
$candidates = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v3.5\csc.exe')
)
$csc = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $csc) {
    throw '找不到 csc.exe（.NET Framework 编译器）。Win10/11 自带；如果是精简系统，装一个 .NET Framework 4.x 或改用 .cmd 入口。'
}

$icon = Join-Path $root 'assets\app-icon.ico'
$hasIcon = Test-Path -LiteralPath $icon

# ---- C# 源码 ----
$source = @'
using System;
using System.Diagnostics;
using System.IO;
using System.Text;

class QqBridgeHost
{
    static int Main(string[] args)
    {
        try { Console.OutputEncoding = Encoding.UTF8; } catch { }

        string root = FindRoot();
        if (root == null)
        {
            Console.Error.WriteLine("[qq-bridge] 没找到 tools\\cli.mjs。");
            Console.Error.WriteLine("[qq-bridge] exe 要和 src\\、tools\\ 放在同一个工程目录里（可以放在它的 dist\\ 子目录）。");
            Pause();
            return 2;
        }

        string cli = Path.Combine(root, "tools", "cli.mjs");
        string node = FindNode(root);
        if (node == null)
        {
            Console.Error.WriteLine("[qq-bridge] 没找到 node。请先安装 Node.js 20+（https://nodejs.org/）。");
            Pause();
            return 2;
        }

        bool interactive = args.Length == 0;
        string argline = interactive ? "start" : string.Join(" ", args);
        Console.WriteLine("[qq-bridge] " + root);
        Console.WriteLine("[qq-bridge] node tools\\cli.mjs " + argline);

        int code = Run(node, cli, argline, root);
        if (!interactive) return code;

        if (code != 0)
        {
            Console.Error.WriteLine("[qq-bridge] 启动失败（退出码 " + code + "）。");
            Pause();
            return code;
        }

        int port = ReadPort(root);
        string url = "http://127.0.0.1:" + port + "/";
        Console.WriteLine("[qq-bridge] 控制台：" + url);
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
        catch (Exception ex) { Console.WriteLine("[qq-bridge] 没打开浏览器：" + ex.Message); }

        Console.WriteLine("[qq-bridge] 服务在后台跑，这个窗口可以直接关。");
        Console.WriteLine("[qq-bridge] 想停服：qq-bridge.exe stop   （或双击「一键停止.cmd」）");
        Pause();
        return 0;
    }

    static string FindRoot()
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        for (int i = 0; i < 4 && !string.IsNullOrEmpty(dir); i++)
        {
            if (File.Exists(Path.Combine(dir, "tools", "cli.mjs"))) return dir;
            DirectoryInfo parent = Directory.GetParent(dir);
            if (parent == null) break;
            dir = parent.FullName.TrimEnd('\\');
        }
        return null;
    }

    static string FindNode(string root)
    {
        string exe = Environment.GetEnvironmentVariable("QQ_NODE") ?? "";
        if (exe.Length > 0 && File.Exists(exe)) return exe;

        string[] names = { "node.exe", "node" };
        string pathVar = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string dir in pathVar.Split(Path.PathSeparator))
        {
            if (dir.Trim().Length == 0) continue;
            foreach (string name in names)
            {
                try
                {
                    string full = Path.Combine(dir.Trim(), name);
                    if (File.Exists(full)) return full;
                }
                catch { }
            }
        }

        string[] guesses = {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs", "node.exe"),
            Path.Combine(Environment.GetEnvironmentVariable("LOCALAPPDATA") ?? "", "Programs", "nodejs", "node.exe"),
        };
        foreach (string guess in guesses) if (guess.Length > 0 && File.Exists(guess)) return guess;
        return null;
    }

    static int Run(string node, string cli, string argline, string root)
    {
        ProcessStartInfo psi = new ProcessStartInfo(node, "\"" + cli + "\" " + argline);
        psi.WorkingDirectory = root;
        psi.UseShellExecute = false;
        psi.RedirectStandardOutput = false;
        psi.RedirectStandardError = false;
        using (Process p = Process.Start(psi))
        {
            p.WaitForExit();
            return p.ExitCode;
        }
    }

    static int ReadPort(string root)
    {
        try
        {
            string file = Path.Combine(root, "state", "webui-port.txt");
            if (File.Exists(file))
            {
                int port;
                if (int.TryParse(File.ReadAllText(file).Trim(), out port)) return port;
            }
        }
        catch { }
        return 5830;
    }

    static void Pause()
    {
        if (Console.IsInputRedirected) return;
        Console.WriteLine("按回车关闭窗口…");
        Console.ReadLine();
    }
}
'@

$srcFile = Join-Path ([IO.Path]::GetTempPath()) ("qq-bridge-host-{0}.cs" -f [Guid]::NewGuid().ToString('N'))
# 带 BOM 写，csc 才不会把中文当成 GBK
$utf8Bom = New-Object System.Text.UTF8Encoding($true)
[IO.File]::WriteAllText($srcFile, $source, $utf8Bom)

$args = @(
    '/nologo',
    '/target:exe',
    '/platform:anycpu',
    '/optimize+',
    ('/out:' + $OutputPath),
    ('/reference:' + (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\System.dll')),
    $srcFile
)
if ($hasIcon) { $args = @('/win32icon:' + $icon) + $args }

Write-Host ('[build-exe] 编译：' + $csc)
$out = & $csc @args 2>&1
if ($LASTEXITCODE -ne 0) {
    $out | ForEach-Object { Write-Host $_ }
    throw ('csc 编译失败，退出码 ' + $LASTEXITCODE)
}
if ($out) { $out | ForEach-Object { Write-Host $_ } }
if (-not $KeepSource) { Remove-Item -LiteralPath $srcFile -Force -ErrorAction SilentlyContinue }

if (-not (Test-Path -LiteralPath $OutputPath)) { throw ('没有生成 exe：' + $OutputPath) }
$size = (Get-Item -LiteralPath $OutputPath).Length
Write-Host ('[build-exe] 好了：' + $OutputPath + '（' + [math]::Round($size / 1KB, 1) + ' KB，图标：' + $(if ($hasIcon) { '有' } else { '无' }) + '）')
Write-Host '[build-exe] 用法：双击它 = 起服务 + 开控制台；带参数 = 转给 tools\cli.mjs（status / stop / logs …）'
