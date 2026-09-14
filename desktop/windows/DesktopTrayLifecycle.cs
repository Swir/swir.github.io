namespace Swir.Desktop.Host;

internal enum DesktopTrayWindowState
{
    Visible,
    Hidden,
    Exiting,
    Disposed
}

internal sealed record DesktopTraySnapshot(
    string Schema,
    bool Enabled,
    string WindowState,
    bool CanHide,
    bool CanRestore,
    bool CanExit,
    DateTimeOffset LastTransitionUtc);

/// <summary>
/// Edition-neutral state machine for the Desktop tray lifecycle.
/// It deliberately owns no native window handles and performs no privileged work;
/// the WinForms adapter maps validated transitions onto the real host window.
/// </summary>
internal sealed class DesktopTrayLifecycle
{
    internal const string Schema = "swir.desktop-tray/0.1";

    private readonly object _gate = new();
    private DesktopTrayWindowState _state = DesktopTrayWindowState.Visible;
    private DateTimeOffset _lastTransitionUtc = DateTimeOffset.UtcNow;

    internal DesktopTraySnapshot Describe()
    {
        lock (_gate)
        {
            return SnapshotUnsafe();
        }
    }

    internal bool RequestHide()
    {
        lock (_gate)
        {
            if (_state is DesktopTrayWindowState.Exiting or DesktopTrayWindowState.Disposed)
                return false;
            if (_state == DesktopTrayWindowState.Hidden)
                return false;

            TransitionUnsafe(DesktopTrayWindowState.Hidden);
            return true;
        }
    }

    internal bool RequestRestore()
    {
        lock (_gate)
        {
            if (_state is DesktopTrayWindowState.Exiting or DesktopTrayWindowState.Disposed)
                return false;
            if (_state == DesktopTrayWindowState.Visible)
                return false;

            TransitionUnsafe(DesktopTrayWindowState.Visible);
            return true;
        }
    }

    internal bool RequestExit()
    {
        lock (_gate)
        {
            if (_state is DesktopTrayWindowState.Exiting or DesktopTrayWindowState.Disposed)
                return false;

            TransitionUnsafe(DesktopTrayWindowState.Exiting);
            return true;
        }
    }

    internal void MarkDisposed()
    {
        lock (_gate)
        {
            if (_state == DesktopTrayWindowState.Disposed)
                return;
            TransitionUnsafe(DesktopTrayWindowState.Disposed);
        }
    }

    private void TransitionUnsafe(DesktopTrayWindowState state)
    {
        _state = state;
        _lastTransitionUtc = DateTimeOffset.UtcNow;
    }

    private DesktopTraySnapshot SnapshotUnsafe()
        => new(
            Schema,
            Enabled: true,
            WindowState: _state.ToString().ToLowerInvariant(),
            CanHide: _state == DesktopTrayWindowState.Visible,
            CanRestore: _state == DesktopTrayWindowState.Hidden,
            CanExit: _state is DesktopTrayWindowState.Visible or DesktopTrayWindowState.Hidden,
            LastTransitionUtc: _lastTransitionUtc);
}
