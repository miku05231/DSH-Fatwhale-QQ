# ============================================================
#  build-exe.ps1 —— 编译 Windows 桌面 / 命令行启动器
#
#  双击：隐藏自身窗口，复用 bootstrap 启动全部组件和托盘，再打开控制台。
#  带参数：原样交给 tools\cli.mjs，保留命令行输出与退出码。
#  使用 Windows 自带的 .NET Framework csc.exe，无额外构建依赖。
# ============================================================
[CmdletBinding()]
param(
    [string]$OutputPath = '',
    [string]$Version = '',
    [switch]$KeepSource
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = [IO.Path]::GetFullPath((Join-Path $scriptDir '..'))

if (-not $Version) {
    $package = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $Version = [string]$package.version
}
if ($Version -notmatch '^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:\.(?<revision>\d+))?(?:[-+][0-9A-Za-z.+-]+)?$') {
    throw '版本号必须是 major.minor.patch（可带第四段、预发布或构建标识）。'
}
$versionParts = @($Matches.major, $Matches.minor, $Matches.patch, $(if ($Matches.revision) { $Matches.revision } else { '0' }))
foreach ($part in $versionParts) {
    if ([decimal]$part -gt 65534) { throw '版本号的每一段不能大于 65534。' }
}
$assemblyVersion = ($versionParts | ForEach-Object { [int]$_ }) -join '.'

if (-not $OutputPath) { $OutputPath = Join-Path $root 'dist\qq-bridge.exe' }
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
$outDir = Split-Path -Parent $OutputPath
if (-not (Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }

$candidates = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$csc = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $csc) { throw '找不到 .NET Framework 4.x 的 csc.exe。请安装 .NET Framework 4.x，或使用 .cmd 入口。' }
$frameworkDir = Split-Path -Parent $csc
$icon = Join-Path $root 'assets\app-icon.ico'
$hasIcon = Test-Path -LiteralPath $icon

$source = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

[assembly: AssemblyTitle("QQ-DSH Launcher")]
[assembly: AssemblyDescription("DSH Fatwhale QQ desktop and command-line launcher")]
[assembly: AssemblyCompany("miku05231")]
[assembly: AssemblyProduct("QQ-DSH (DSH Fatwhale QQ)")]
[assembly: AssemblyVersion("__ASSEMBLY_VERSION__")]
[assembly: AssemblyFileVersion("__ASSEMBLY_VERSION__")]
[assembly: AssemblyInformationalVersion("__INFORMATIONAL_VERSION__")]

class QqBridgeHost
{
    const string ProductName = "QQ-DSH";

    [DllImport("kernel32.dll")]
    static extern IntPtr GetConsoleWindow();
    [DllImport("kernel32.dll")]
    static extern uint GetConsoleProcessList([Out] uint[] processList, uint processCount);
    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr window, int command);

    [STAThread]
    static int Main(string[] args)
    {
        try { Console.OutputEncoding = Encoding.UTF8; } catch { }
        bool desktop = args.Length == 0;
        bool showDialog = desktop && Environment.UserInteractive
            && !Console.IsInputRedirected && !Console.IsOutputRedirected && !Console.IsErrorRedirected;
        if (desktop) HideOwnConsole();

        try
        {
            string root = FindRoot();
            if (root == null)
            {
                ReportError("没找到 tools\\cli.mjs。\r\n请把启动器放在完整工程目录或它的 dist 子目录里。", showDialog);
                return 2;
            }

            if (desktop) return RunDesktop(root, showDialog);

            string node = FindNode();
            if (node == null)
            {
                ReportError("没找到 node。请先安装 Node.js 18+（https://nodejs.org/）。", false);
                return 2;
            }

            Console.WriteLine("[qq-bridge] " + root);
            Console.WriteLine("[qq-bridge] node tools\\cli.mjs " + string.Join(" ", args));
            List<string> arguments = new List<string>();
            arguments.Add(Path.Combine(root, "tools", "cli.mjs"));
            arguments.AddRange(args);
            ProcessStartInfo info = new ProcessStartInfo(node, ArgumentLine(arguments));
            info.WorkingDirectory = root;
            info.UseShellExecute = false;
            using (Process process = Process.Start(info))
            {
                process.WaitForExit();
                return process.ExitCode;
            }
        }
        catch (Exception ex)
        {
            ReportError(ex.Message, showDialog);
            return 2;
        }
    }

    static void HideOwnConsole()
    {
        try
        {
            // A terminal shared with the caller must stay visible.
            IntPtr window = GetConsoleWindow();
            uint[] processes = new uint[2];
            if (window != IntPtr.Zero && GetConsoleProcessList(processes, 2) == 1)
                ShowWindow(window, 0);
        }
        catch { }
    }

    static int RunDesktop(string root, bool showDialog)
    {
        string bootstrap = Path.Combine(root, "launcher", "bootstrap.ps1");
        if (!File.Exists(bootstrap))
        {
            ReportError("找不到 launcher\\bootstrap.ps1。\r\n请重新解压完整便携包。", showDialog);
            return 2;
        }

        string powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),
            "WindowsPowerShell", "v1.0", "powershell.exe");
        if (!File.Exists(powershell)) powershell = "powershell.exe";
        // -EncodedCommand keeps Unicode paths intact; set PS 5.1's redirected encoding explicitly.
        string command = "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); "
            + "$ErrorActionPreference = 'Stop'; try { & '" + bootstrap.Replace("'", "''")
            + "'; $completed = $?; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }; "
            + "if (-not $completed) { exit 1 }; exit 0 } "
            + "catch { [Console]::Error.WriteLine($_.ToString()); exit 1 }";
        ProcessStartInfo info = new ProcessStartInfo(powershell, ArgumentLine(new string[] {
            "-NoProfile", "-NonInteractive", "-STA", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass",
            "-OutputFormat", "Text", "-EncodedCommand", Convert.ToBase64String(Encoding.Unicode.GetBytes(command))
        }));
        info.WorkingDirectory = root;
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.WindowStyle = ProcessWindowStyle.Hidden;
        info.RedirectStandardOutput = true;
        info.RedirectStandardError = true;
        info.StandardOutputEncoding = new UTF8Encoding(false);
        info.StandardErrorEncoding = new UTF8Encoding(false);
        StringBuilder output = new StringBuilder();
        DataReceivedEventHandler capture = delegate(object sender, DataReceivedEventArgs e) {
            if (e.Data == null) return;
            lock (output)
            {
                output.AppendLine(e.Data);
                if (output.Length > 6000) output.Remove(0, output.Length - 6000);
            }
        };
        using (Process process = new Process())
        {
            process.StartInfo = info;
            process.OutputDataReceived += capture;
            process.ErrorDataReceived += capture;
            process.Start();
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            process.WaitForExit();
            if (process.ExitCode != 0)
            {
                ReportError("启动失败（退出码 " + process.ExitCode + "）。\r\n"
                    + output.ToString().Trim() + "\r\n\r\n详情见 state\\launcher.log。", showDialog);
                return process.ExitCode;
            }
        }
        OpenConsole(root);
        return 0;
    }

    static string FindRoot()
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        for (int i = 0; i < 4 && !string.IsNullOrEmpty(dir); i++)
        {
            if (File.Exists(Path.Combine(dir, "tools", "cli.mjs"))) return Path.GetFullPath(dir).TrimEnd('\\');
            DirectoryInfo parent = Directory.GetParent(dir.TrimEnd('\\'));
            if (parent == null) break;
            dir = parent.FullName;
        }
        return null;
    }

    static string FindNode()
    {
        string configured = Environment.GetEnvironmentVariable("QQ_NODE") ?? "";
        if (configured.Length > 0 && File.Exists(configured)) return configured;

        string pathVar = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string dir in pathVar.Split(Path.PathSeparator))
        {
            if (dir.Trim().Length == 0) continue;
            foreach (string name in new string[] { "node.exe", "node" })
            {
                try
                {
                    string full = Path.Combine(dir.Trim().Trim('"'), name);
                    if (File.Exists(full)) return full;
                }
                catch { }
            }
        }

        string[] guesses = {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs", "node.exe"),
            Path.Combine(Environment.GetEnvironmentVariable("LOCALAPPDATA") ?? "", "Programs", "nodejs", "node.exe")
        };
        foreach (string guess in guesses) if (File.Exists(guess)) return guess;
        return null;
    }

    static string ArgumentLine(IEnumerable<string> arguments)
    {
        List<string> quoted = new List<string>();
        foreach (string argument in arguments) quoted.Add(QuoteArgument(argument));
        return string.Join(" ", quoted.ToArray());
    }

    static string QuoteArgument(string value)
    {
        // Windows doubles backslashes before quotes and before the closing quote.
        StringBuilder result = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char ch in value)
        {
            if (ch == '\\') { backslashes++; continue; }
            if (ch == '"') result.Append('\\', backslashes * 2 + 1);
            else result.Append('\\', backslashes);
            result.Append(ch);
            backslashes = 0;
        }
        result.Append('\\', backslashes * 2);
        result.Append('"');
        return result.ToString();
    }

    static void OpenConsole(string root)
    {
        string url = "http://127.0.0.1:" + ReadPort(root) + "/";
        foreach (string folder in new string[] {
            Environment.GetEnvironmentVariable("ProgramFiles(x86)"),
            Environment.GetEnvironmentVariable("ProgramFiles"),
            Environment.GetEnvironmentVariable("LOCALAPPDATA")
        })
        {
            if (string.IsNullOrEmpty(folder)) continue;
            string edge = Path.Combine(folder, "Microsoft", "Edge", "Application", "msedge.exe");
            if (!File.Exists(edge)) continue;
            try
            {
                Process.Start(new ProcessStartInfo(edge, ArgumentLine(new string[] {
                    "--app=" + url, "--window-size=1180,820"
                })) { UseShellExecute = true, WorkingDirectory = root });
                return;
            }
            catch { }
        }
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
        catch (Exception ex) { throw new InvalidOperationException("打不开控制台，请手动访问 " + url + "\r\n" + ex.Message, ex); }
    }

    static int ReadPort(string root)
    {
        try
        {
            string file = Path.Combine(root, "state", "webui-port.txt");
            int port;
            if (File.Exists(file) && int.TryParse(File.ReadAllText(file).Trim(), out port)
                && port > 0 && port <= 65535) return port;
        }
        catch { }
        return 5830;
    }

    static void ReportError(string message, bool showDialog)
    {
        try { Console.Error.WriteLine("[" + ProductName + "] " + message); } catch { }
        if (showDialog)
            MessageBox.Show(message, ProductName + " · 启动器", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }
}
'@
$source = $source.Replace('__ASSEMBLY_VERSION__', $assemblyVersion).Replace('__INFORMATIONAL_VERSION__', $Version)

$manifest = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity version="__ASSEMBLY_VERSION__" name="QQDSH.Launcher" type="win32" />
  <description>QQ-DSH Launcher</description>
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
      <requestedPrivileges><requestedExecutionLevel level="asInvoker" uiAccess="false" /></requestedPrivileges>
    </security>
  </trustInfo>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application><supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}" /></application>
  </compatibility>
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true/PM</dpiAware>
      <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2,PerMonitor</dpiAwareness>
    </windowsSettings>
  </application>
</assembly>
'@
$manifest = $manifest.Replace('__ASSEMBLY_VERSION__', $assemblyVersion)

$tempBase = Join-Path ([IO.Path]::GetTempPath()) ("qq-bridge-host-{0}" -f [Guid]::NewGuid().ToString('N'))
$srcFile = $tempBase + '.cs'
$manifestFile = $tempBase + '.manifest'
$utf8Bom = New-Object System.Text.UTF8Encoding($true)
try {
    [IO.File]::WriteAllText($srcFile, $source, $utf8Bom)
    [IO.File]::WriteAllText($manifestFile, $manifest, $utf8Bom)
    $compilerArgs = @(
        '/nologo',
        '/target:exe',
        '/platform:anycpu',
        '/optimize+',
        ('/out:' + $OutputPath),
        ('/win32manifest:' + $manifestFile),
        ('/reference:' + (Join-Path $frameworkDir 'System.dll')),
        ('/reference:' + (Join-Path $frameworkDir 'System.Windows.Forms.dll')),
        $srcFile
    )
    if ($hasIcon) { $compilerArgs = @('/win32icon:' + $icon) + $compilerArgs }

    Write-Host ('[build-exe] 编译：' + $csc)
    $compilerOutput = & $csc @compilerArgs 2>&1
    if ($compilerOutput) { $compilerOutput | ForEach-Object { Write-Host $_ } }
    if ($LASTEXITCODE -ne 0) { throw ('csc 编译失败，退出码 ' + $LASTEXITCODE) }
    if (-not (Test-Path -LiteralPath $OutputPath)) { throw ('没有生成 exe：' + $OutputPath) }
} finally {
    if (-not $KeepSource) {
        Remove-Item -LiteralPath $srcFile, $manifestFile -Force -ErrorAction SilentlyContinue
    } else {
        Write-Host ('[build-exe] 构建源码：' + $srcFile)
        Write-Host ('[build-exe] Windows 清单：' + $manifestFile)
    }
}

$size = (Get-Item -LiteralPath $OutputPath).Length
Write-Host ('[build-exe] 好了：' + $OutputPath + '（' + [math]::Round($size / 1KB, 1) + ' KB，版本 ' + $Version + '，图标：' + $(if ($hasIcon) { '有' } else { '无' }) + '）')
Write-Host '[build-exe] 双击 = 一键启动 + 托盘 + 控制台；带参数 = 命令行（status / stop / logs …）'
