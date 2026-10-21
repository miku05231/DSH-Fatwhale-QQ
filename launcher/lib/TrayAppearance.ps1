<#
    托盘菜单与退出确认框的 Material 3 外观。
    只定义函数；加载本文件不会启动服务、显示窗口或修改用户设置。
    Windows PowerShell 5.1 / .NET Framework，UTF-8 with BOM。
#>

function Initialize-LauncherAppearance {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    Add-Type -AssemblyName System.Drawing -ErrorAction Stop
    if ($null -ne ('QqDshLauncher.Appearance.TrayRenderer' -as [type])) { return }

    Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace QqDshLauncher.Appearance
{
    internal static class Shape
    {
        public static GraphicsPath Rounded(Rectangle bounds, int radius)
        {
            GraphicsPath path = new GraphicsPath();
            int diameter = Math.Max(2, Math.Min(radius * 2, Math.Min(bounds.Width, bounds.Height)));
            path.AddArc(bounds.Left, bounds.Top, diameter, diameter, 180, 90);
            path.AddArc(bounds.Right - diameter, bounds.Top, diameter, diameter, 270, 90);
            path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
            path.AddArc(bounds.Left, bounds.Bottom - diameter, diameter, diameter, 90, 90);
            path.CloseFigure();
            return path;
        }
    }

    public sealed class TrayMenu : ContextMenuStrip
    {
        public float LayoutScale = 1;
        private readonly Timer dismissTimer;
        private IntPtr foregroundWindow, overflowWindow;
        private bool mouseWasDown;

        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern IntPtr FindWindow(string className, string title);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);

        public TrayMenu()
        {
            ShowImageMargin = false;
            ShowCheckMargin = false;
            AutoSize = false;
            AutoClose = true;
            dismissTimer = new Timer();
            dismissTimer.Interval = 75;
            dismissTimer.Tick += delegate { DismissIfInactive(); };
        }

        private static bool IsMouseButtonDown()
        {
            return GetAsyncKeyState(1) < 0 || GetAsyncKeyState(2) < 0;
        }

        protected override void OnOpened(EventArgs e)
        {
            if (!TopLevel) { base.OnOpened(e); return; }
            overflowWindow = FindWindow("TopLevelWindowForOverflowXamlIsland", null);
            if (overflowWindow == IntPtr.Zero || !IsWindowVisible(overflowWindow))
                overflowWindow = FindWindow("NotifyIconOverflowWindow", null);
            if (overflowWindow != IntPtr.Zero && !IsWindowVisible(overflowWindow))
                overflowWindow = IntPtr.Zero;
            foregroundWindow = GetForegroundWindow();
            mouseWasDown = IsMouseButtonDown();
            dismissTimer.Start();
            base.OnOpened(e);
        }

        private void DismissIfInactive()
        {
            if (!Visible) return;
            IntPtr current = GetForegroundWindow();
            bool down = IsMouseButtonDown();
            bool outsideClick = down && !mouseWasDown && !Bounds.Contains(Cursor.Position);
            mouseWasDown = down;
            if (outsideClick ||
                (overflowWindow != IntPtr.Zero && !IsWindowVisible(overflowWindow)) ||
                (current != IntPtr.Zero && current != Handle && current != foregroundWindow))
                Close(ToolStripDropDownCloseReason.AppFocusChange);
        }

        protected override void OnClosed(ToolStripDropDownClosedEventArgs e)
        {
            dismissTimer.Stop();
            base.OnClosed(e);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) dismissTimer.Dispose();
            base.Dispose(disposing);
        }

        protected override void OnSizeChanged(EventArgs e)
        {
            base.OnSizeChanged(e);
            if (Width < 2 || Height < 2) return;
            Region previous = Region;
            using (GraphicsPath path = Shape.Rounded(ClientRectangle, (int)(8 * LayoutScale)))
                Region = new Region(path);
            if (previous != null) previous.Dispose();
        }
    }

    public sealed class TrayRenderer : ToolStripProfessionalRenderer
    {
        public Color Surface, Text, Muted, Hover, Error, Outline;

        public TrayRenderer(Color surface, Color text, Color muted, Color hover, Color error, Color outline)
        {
            Surface = surface; Text = text; Muted = muted;
            Hover = hover; Error = error; Outline = outline;
            RoundedEdges = false;
        }

        protected override void OnRenderToolStripBackground(ToolStripRenderEventArgs e)
        {
            e.Graphics.Clear(Surface);
        }

        protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e)
        {
            TrayMenu menu = e.ToolStrip as TrayMenu;
            float scale = menu == null ? 1 : menu.LayoutScale;
            Rectangle bounds = e.ToolStrip.ClientRectangle;
            bounds.Width--; bounds.Height--;
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (GraphicsPath path = Shape.Rounded(bounds, (int)(8 * scale)))
            using (Pen pen = new Pen(Outline))
                e.Graphics.DrawPath(pen, path);
        }

        protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e)
        {
            if (!e.Item.Selected && !e.Item.Pressed) return;
            TrayMenu menu = e.ToolStrip as TrayMenu;
            float scale = menu == null ? 1 : menu.LayoutScale;
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (GraphicsPath path = Shape.Rounded(new Rectangle(Point.Empty, e.Item.Size), (int)(8 * scale)))
            using (Brush brush = new SolidBrush(Hover))
                e.Graphics.FillPath(brush, path);
        }

        protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
        {
            TrayMenu menu = e.ToolStrip as TrayMenu;
            float scale = menu == null ? 1 : menu.LayoutScale;
            Func<int, int> px = delegate(int value) { return (int)Math.Round(value * scale); };
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (Pen pen = new Pen(Error, 1.8f * scale))
            {
                pen.StartCap = LineCap.Round;
                pen.EndCap = LineCap.Round;
                e.Graphics.DrawArc(pen, px(10), px(10), px(14), px(14), -55, 290);
                e.Graphics.DrawLine(pen, px(17), px(7), px(17), px(16));
            }
            string title = e.Item.Text.Split('\uFF08')[0];
            TextFormatFlags flags = TextFormatFlags.NoPadding | TextFormatFlags.SingleLine |
                TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis;
            TextRenderer.DrawText(e.Graphics, title, e.TextFont,
                new Rectangle(px(36), 0, e.Item.Width - px(44), e.Item.Height), Text, flags);
        }
    }

    public sealed class TonalButton : Button
    {
        public Color NormalColor, HoverColor, PressedColor, TextColor;
        private bool hovered, pressed;

        public TonalButton()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            FlatStyle = FlatStyle.Flat;
            FlatAppearance.BorderSize = 0;
        }

        protected override void OnMouseEnter(EventArgs e) { hovered = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { hovered = false; pressed = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnMouseDown(MouseEventArgs e) { pressed = true; Invalidate(); base.OnMouseDown(e); }
        protected override void OnMouseUp(MouseEventArgs e) { pressed = false; Invalidate(); base.OnMouseUp(e); }
        protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
        protected override void OnLostFocus(EventArgs e) { Invalidate(); base.OnLostFocus(e); }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.Clear(Parent == null ? BackColor : Parent.BackColor);
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            Rectangle bounds = ClientRectangle;
            bounds.Width--; bounds.Height--;
            int radius = (int)Math.Round(8 * e.Graphics.DpiX / 96);
            using (GraphicsPath path = Shape.Rounded(bounds, radius))
            using (Brush brush = new SolidBrush(pressed ? PressedColor : hovered ? HoverColor : NormalColor))
                e.Graphics.FillPath(brush, path);
            TextRenderer.DrawText(e.Graphics, Text, Font, ClientRectangle, TextColor,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine);
            if (Focused && ShowFocusCues)
                ControlPaint.DrawFocusRectangle(e.Graphics, Rectangle.Inflate(ClientRectangle, -6, -6), TextColor, NormalColor);
        }
    }
}
'@ -ErrorAction Stop
}

function Get-LauncherPalette {
    param([ValidateSet('System', 'Light', 'Dark')][string]$Theme = 'System')

    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    if ([System.Windows.Forms.SystemInformation]::HighContrast) {
        return [pscustomobject]@{
            BackColor = [System.Drawing.SystemColors]::Menu
            ForeColor = [System.Drawing.SystemColors]::MenuText
            MutedColor = [System.Drawing.SystemColors]::MenuText
            HoverColor = [System.Drawing.SystemColors]::Highlight
            ErrorColor = [System.Drawing.SystemColors]::MenuText
            ErrorHoverColor = [System.Drawing.SystemColors]::Highlight
            OutlineColor = [System.Drawing.SystemColors]::WindowFrame
            PrimaryColor = [System.Drawing.SystemColors]::Highlight
            PrimaryHoverColor = [System.Drawing.SystemColors]::Highlight
            PrimaryPressedColor = [System.Drawing.SystemColors]::Highlight
            OnPrimaryColor = [System.Drawing.SystemColors]::HighlightText
            SecondaryColor = [System.Drawing.SystemColors]::Control
            HighContrast = $true
        }
    }

    $dark = ($Theme -eq 'Dark')
    if ($Theme -eq 'System') {
        try {
            $preferences = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -ErrorAction Stop
            $dark = ($preferences.AppsUseLightTheme -eq 0)
        } catch { $dark = $false }
    }
    if ($dark) {
        $colors = @('#2b2930', '#e6e0e9', '#cac4d0', '#36343b', '#f2b8b5', '#601410', '#49454f', '#d0bcff', '#381e72', '#4a4458', '#ddceff', '#bca5ef')
    } else {
        $colors = @('#f3edf7', '#1d1b20', '#49454f', '#e8def8', '#b3261e', '#f9dedc', '#cac4d0', '#6750a4', '#ffffff', '#e8def8', '#5d4597', '#513a87')
    }
    $keys = @('BackColor', 'ForeColor', 'MutedColor', 'HoverColor', 'ErrorColor', 'ErrorHoverColor', 'OutlineColor', 'PrimaryColor', 'OnPrimaryColor', 'SecondaryColor', 'PrimaryHoverColor', 'PrimaryPressedColor')
    $palette = [ordered]@{}
    for ($index = 0; $index -lt $keys.Count; $index++) {
        $palette[$keys[$index]] = [System.Drawing.ColorTranslator]::FromHtml($colors[$index])
    }
    $palette.HighContrast = $false
    return [pscustomobject]$palette
}

function Set-LauncherTrayTheme {
    param([System.Windows.Forms.ContextMenuStrip]$Menu, $Palette)

    if ($null -eq $Palette) { $Palette = Get-LauncherPalette }
    $Menu.BackColor = $Palette.BackColor
    $Menu.ForeColor = $Palette.ForeColor
    if ($Palette.HighContrast) {
        $Menu.Renderer = [System.Windows.Forms.ToolStripSystemRenderer]::new()
    } else {
        $Menu.Renderer = [QqDshLauncher.Appearance.TrayRenderer]::new(
            $Palette.BackColor, $Palette.ForeColor, $Palette.MutedColor,
            $Palette.HoverColor, $Palette.ErrorColor, $Palette.OutlineColor)
    }
    $graphics = $Menu.CreateGraphics()
    try { $scale = $graphics.DpiX / 96.0 } finally { $graphics.Dispose() }
    $Menu.LayoutScale = $scale
    $Menu.Padding = [System.Windows.Forms.Padding]::new([int](4 * $scale))
    $Menu.Size = [System.Drawing.Size]::new([int](136 * $scale), [int](40 * $scale))
    if ($Menu.Items.Count -gt 0) {
        $Menu.Items[0].Size = [System.Drawing.Size]::new([int](128 * $scale), [int](32 * $scale))
        $Menu.Items[0].ForeColor = $Palette.ForeColor
    }
    $Menu.Invalidate()
}

function New-LauncherTrayMenu {
    param($Palette)

    Initialize-LauncherAppearance
    $menu = [QqDshLauncher.Appearance.TrayMenu]::new()
    $menu.Font = [System.Drawing.Font]::new('Microsoft YaHei UI', 9)
    $menu.AccessibleName = 'QQ-DSH 托盘菜单'
    $menu.Tag = $Palette
    $item = [System.Windows.Forms.ToolStripMenuItem]::new('退出')
    $item.Name = 'exitMenuItem'
    $item.AccessibleName = '退出（停止桥接与 NapCat）'
    $item.Tag = '停止桥接与 NapCat'
    $item.ToolTipText = '停止桥接与 NapCat，QQ 机器人将下线，DSH 继续运行。'
    $item.AutoSize = $false
    $null = $menu.Items.Add($item)
    Set-LauncherTrayTheme -Menu $menu -Palette $Palette
    $menu.Add_Opening({
        param($sender, $eventArgs)
        try { Set-LauncherTrayTheme -Menu $sender -Palette $sender.Tag } catch { }
    })
    $menu.Add_Disposed({
        param($sender, $eventArgs)
        if ($null -ne $sender.Font) { $sender.Font.Dispose() }
    })
    return $menu
}

function New-LauncherExitDialog {
    param($Palette, [System.Drawing.Icon]$Icon)

    Initialize-LauncherAppearance
    if ($null -eq $Palette) { $Palette = Get-LauncherPalette }
    $form = [System.Windows.Forms.Form]::new()
    $form.Text = '退出 QQ-DSH 启动器'
    $form.Name = 'launcherExitDialog'
    $form.AccessibleName = $form.Text
    $form.ClientSize = [System.Drawing.Size]::new(440, 232)
    $form.AutoScaleDimensions = [System.Drawing.SizeF]::new(96, 96)
    $form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::Dpi
    $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
    $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
    $form.MaximizeBox = $false
    $form.MinimizeBox = $false
    $form.ShowInTaskbar = $false
    $form.BackColor = $Palette.BackColor
    $form.ForeColor = $Palette.ForeColor
    $form.Font = [System.Drawing.Font]::new('Microsoft YaHei UI', 10)
    if ($null -ne $Icon) { $form.Icon = $Icon }

    $title = [System.Windows.Forms.Label]::new()
    $title.Name = 'exitTitle'
    $title.Text = '退出 QQ-DSH 启动器？'
    $title.Font = [System.Drawing.Font]::new($form.Font.FontFamily, 14, [System.Drawing.FontStyle]::Bold)
    $title.SetBounds(24, 24, 392, 36)
    $title.AutoEllipsis = $true

    $body = [System.Windows.Forms.Label]::new()
    $body.Name = 'exitBody'
    $body.Text = "退出后会停止桥接和 NapCat，QQ 机器人将下线。`r`nDSH 继续运行。"
    $body.ForeColor = $Palette.MutedColor
    $body.SetBounds(24, 76, 392, 64)

    if ($Palette.HighContrast) {
        $cancel = [System.Windows.Forms.Button]::new()
        $exit = [System.Windows.Forms.Button]::new()
    } else {
        $cancel = [QqDshLauncher.Appearance.TonalButton]::new()
        $cancel.NormalColor = $Palette.SecondaryColor
        $cancel.HoverColor = $Palette.HoverColor
        $cancel.PressedColor = $Palette.OutlineColor
        $cancel.TextColor = $Palette.ForeColor
        $exit = [QqDshLauncher.Appearance.TonalButton]::new()
        $exit.NormalColor = $Palette.PrimaryColor
        $exit.HoverColor = $Palette.PrimaryHoverColor
        $exit.PressedColor = $Palette.PrimaryPressedColor
        $exit.TextColor = $Palette.OnPrimaryColor
    }
    $cancel.Name = 'cancelButton'
    $cancel.Text = '取消'
    $cancel.AccessibleName = '取消退出'
    $cancel.DialogResult = [System.Windows.Forms.DialogResult]::No
    $cancel.TabIndex = 0
    $cancel.SetBounds(200, 168, 100, 40)
    $exit.Name = 'exitButton'
    $exit.Text = '退出'
    $exit.AccessibleName = '停止桥接与 NapCat 并退出'
    $exit.DialogResult = [System.Windows.Forms.DialogResult]::Yes
    $exit.TabIndex = 1
    $exit.SetBounds(312, 168, 104, 40)
    $form.Controls.AddRange([System.Windows.Forms.Control[]]@($title, $body, $cancel, $exit))
    $form.AcceptButton = $cancel
    $form.CancelButton = $cancel
    $form.Tag = @($title.Font, $form.Font)
    $form.Add_Shown({ param($sender, $eventArgs) $sender.ActiveControl = $sender.Controls['cancelButton'] })
    $form.Add_Disposed({
        param($sender, $eventArgs)
        foreach ($font in $sender.Tag) { $font.Dispose() }
    })
    return $form
}

function Show-LauncherExitConfirmation {
    param([System.Drawing.Icon]$Icon)

    $dialog = $null
    try {
        $dialog = New-LauncherExitDialog -Icon $Icon
        return $dialog.ShowDialog()
    } catch {
        return [System.Windows.Forms.MessageBox]::Show(
            "确定要退出「QQ-DSH 启动器」吗？`r`n`r`n退出前会停止桥接和 NapCat，QQ 机器人下线；DSH 继续运行。",
            '退出 QQ-DSH 启动器', [System.Windows.Forms.MessageBoxButtons]::YesNo,
            [System.Windows.Forms.MessageBoxIcon]::Question, [System.Windows.Forms.MessageBoxDefaultButton]::Button2)
    } finally {
        if ($null -ne $dialog) { $dialog.Dispose() }
    }
}
