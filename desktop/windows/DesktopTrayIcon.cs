using System.Drawing;

namespace Swir.Desktop.Host;

/// <summary>
/// Native Windows notification-area adapter for SWIR Desktop Host.
/// The adapter is intentionally host-owned: web content cannot create arbitrary
/// tray icons or bypass the native permission boundary.
/// </summary>
internal sealed class DesktopTrayIcon : IDisposable
{
    private readonly Form _window;
    private readonly DesktopTrayLifecycle _lifecycle;
    private readonly NativeNotificationPolicy _notificationPolicy = new();
    private readonly NotifyIcon _notifyIcon;
    private readonly ToolStripMenuItem _showItem;
    private readonly ToolStripMenuItem _hideItem;
    private readonly ToolStripMenuItem _exitItem;
    private bool _disposed;

    internal DesktopTrayIcon(Form window, DesktopTrayLifecycle lifecycle)
    {
        _window = window ?? throw new ArgumentNullException(nameof(window));
        _lifecycle = lifecycle ?? throw new ArgumentNullException(nameof(lifecycle));

        _showItem = new ToolStripMenuItem("Show SWIR OS", null, (_, _) => Restore());
        _hideItem = new ToolStripMenuItem("Hide to tray", null, (_, _) => Hide());
        _exitItem = new ToolStripMenuItem("Exit SWIR OS", null, (_, _) => Exit());

        var menu = new ContextMenuStrip();
        menu.Items.AddRange(new ToolStripItem[]
        {
            _showItem,
            _hideItem,
            new ToolStripSeparator(),
            _exitItem
        });

        _notifyIcon = new NotifyIcon
        {
            Text = "SWIR OS Desktop Edition",
            Icon = SystemIcons.Application,
            ContextMenuStrip = menu,
            Visible = true
        };
        _notifyIcon.DoubleClick += (_, _) => Restore();
        RefreshMenu();
    }

    internal DesktopTraySnapshot Describe() => _lifecycle.Describe();

    internal object ShowNotification(string title, string message, string appId, bool silent = false)
    {
        EnsureUiThread();
        var request = _notificationPolicy.Prepare(title, message, appId, silent);

        // WinForms NotifyIcon uses the Windows notification area and does not require
        // a second process, arbitrary executable activation, or browser Notification permission.
        // Silent is retained in the portable result even though classic NotifyIcon balloons
        // do not expose a reliable per-notification sound switch across supported Windows builds.
        _notifyIcon.BalloonTipTitle = request.Title;
        _notifyIcon.BalloonTipText = request.Message;
        _notifyIcon.BalloonTipIcon = ToolTipIcon.Info;
        _notifyIcon.ShowBalloonTip(5000);
        return new
        {
            schema = "swir.native-notification/0.2",
            delivered = true,
            provider = "windows-notifyicon",
            appId = request.AppId,
            title = request.Title,
            message = request.Message,
            silentRequested = request.Silent,
            actionsSupported = false,
            persistenceSupported = false,
            abuseControls = new { duplicateSuppression = true, perAppRateLimit = true }
        };
    }

    internal bool Hide()
    {
        EnsureUiThread();
        if (!_lifecycle.RequestHide())
        {
            RefreshMenu();
            return false;
        }

        _window.Hide();
        RefreshMenu();
        return true;
    }

    internal bool Restore()
    {
        EnsureUiThread();
        if (!_lifecycle.RequestRestore())
        {
            if (_window.Visible)
            {
                _window.Activate();
                _window.BringToFront();
            }
            RefreshMenu();
            return false;
        }

        if (_window.WindowState == FormWindowState.Minimized)
            _window.WindowState = FormWindowState.Normal;
        _window.Show();
        _window.Activate();
        _window.BringToFront();
        RefreshMenu();
        return true;
    }

    internal bool Exit()
    {
        EnsureUiThread();
        if (!_lifecycle.RequestExit())
            return false;

        _notifyIcon.Visible = false;
        _window.Close();
        return true;
    }

    private void RefreshMenu()
    {
        if (_disposed) return;
        var state = _lifecycle.Describe();
        _showItem.Enabled = state.CanRestore;
        _hideItem.Enabled = state.CanHide;
        _exitItem.Enabled = state.CanExit;
    }

    private void EnsureUiThread()
    {
        if (_disposed) throw new ObjectDisposedException(nameof(DesktopTrayIcon));
        if (_window.InvokeRequired)
            throw new InvalidOperationException("Desktop tray operations must run on the host UI thread.");
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _lifecycle.MarkDisposed();
        _notifyIcon.Visible = false;
        _notifyIcon.Dispose();
    }
}
