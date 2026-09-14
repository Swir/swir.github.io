using System.ComponentModel;

namespace Swir.Desktop.Host;

internal sealed class DesktopShellIntegrationCoordinator : IDisposable
{
    private const string Schema = "swir.desktop-shell-host-integration/0.1";
    private static readonly string[] AssociationExtensions = { ".txt", ".md", ".log", ".json", ".swirapp" };
    private static readonly HostShortcut[] HostShortcuts =
    {
        new(41001, DesktopShellIntegrationBroker.ShortcutModifiers.Control | DesktopShellIntegrationBroker.ShortcutModifiers.Alt, 0x53, "shell.toggle-visibility"),
        new(41002, DesktopShellIntegrationBroker.ShortcutModifiers.Control | DesktopShellIntegrationBroker.ShortcutModifiers.Alt, 0x4D, "shell.open-matrix")
    };

    private readonly DesktopShellIntegrationBroker _shell;
    private readonly DesktopOpenFileActivationBroker _openFiles;
    private readonly string _executablePath;
    private readonly Func<string, string, object> _capabilityFactory;
    private readonly object _gate = new();
    private readonly List<string> _shortcutWarnings = new();
    private bool _windowInitialized;
    private bool _disposed;

    public DesktopShellIntegrationCoordinator(
        string executablePath,
        Func<string, string, object> capabilityFactory,
        DesktopShellIntegrationBroker? shell = null,
        DesktopOpenFileActivationBroker? openFiles = null)
    {
        if (string.IsNullOrWhiteSpace(executablePath)) throw new ArgumentException("Desktop Host executable path is required.", nameof(executablePath));
        _executablePath = Path.GetFullPath(executablePath);
        if (!File.Exists(_executablePath)) throw new FileNotFoundException("Desktop Host executable does not exist.", _executablePath);
        _capabilityFactory = capabilityFactory ?? throw new ArgumentNullException(nameof(capabilityFactory));
        _shell = shell ?? new DesktopShellIntegrationBroker();
        _openFiles = openFiles ?? new DesktopOpenFileActivationBroker();
    }

    public object Describe()
    {
        ThrowIfDisposed();
        lock (_gate)
        {
            return new
            {
                schema = Schema,
                platform = "windows",
                hostOwnedGlobalShortcuts = true,
                applicationDefinedGlobalShortcuts = false,
                windowInitialized = _windowInitialized,
                shortcuts = HostShortcuts.Select(item => new
                {
                    id = item.Id,
                    modifiers = item.Modifiers.ToString(),
                    virtualKey = item.VirtualKey,
                    action = item.Action
                }).ToArray(),
                shortcutWarnings = _shortcutWarnings.ToArray(),
                associations = AssociationExtensions.ToArray(),
                associationScope = "current-user",
                associationRollbackSupported = true,
                changesWindowsUserChoice = false,
                openFiles = _openFiles.Describe(),
                shell = _shell.Describe()
            };
        }
    }

    public DesktopOpenFileActivationBroker.ActivationDescriptor? CaptureStartupArguments(IEnumerable<string> arguments)
    {
        ThrowIfDisposed();
        return _openFiles.CaptureCommandLine(arguments);
    }

    public DesktopShellIntegrationBroker.AssociationResult[] RegisterCurrentUserFileHandlers()
    {
        ThrowIfDisposed();
        return AssociationExtensions
            .Select(extension => _shell.PlanAssociation(extension, _executablePath))
            .Select(_shell.RegisterCurrentUserAssociation)
            .ToArray();
    }

    public DesktopShellIntegrationBroker.AssociationResult[] RemoveCurrentUserFileHandlers()
    {
        ThrowIfDisposed();
        return AssociationExtensions
            .Select(_shell.RemoveCurrentUserAssociation)
            .ToArray();
    }

    public ShortcutInitializationResult InitializeWindow(IntPtr windowHandle)
    {
        ThrowIfDisposed();
        if (windowHandle == IntPtr.Zero) throw new ArgumentException("A valid Desktop Host window handle is required.", nameof(windowHandle));

        lock (_gate)
        {
            if (_windowInitialized)
                return new ShortcutInitializationResult(true, HostShortcuts.Length - _shortcutWarnings.Count, _shortcutWarnings.ToArray());

            _shortcutWarnings.Clear();
            var registered = 0;
            foreach (var shortcut in HostShortcuts)
            {
                try
                {
                    _shell.RegisterShortcut(windowHandle, shortcut.Id, shortcut.Modifiers, shortcut.VirtualKey, shortcut.Action);
                    registered++;
                }
                catch (Win32Exception ex)
                {
                    _shortcutWarnings.Add($"{shortcut.Action}: {ex.Message}");
                }
            }

            _windowInitialized = true;
            return new ShortcutInitializationResult(true, registered, _shortcutWarnings.ToArray());
        }
    }

    public bool TryResolveHotKey(int id, out string? action)
    {
        ThrowIfDisposed();
        return _shell.TryResolveShortcut(id, out action);
    }

    public DesktopOpenFileActivationBroker.ActivationDescriptor[] PendingOpenFiles()
    {
        ThrowIfDisposed();
        return _openFiles.Pending();
    }

    public DesktopOpenFileActivationBroker.ApplicationActivation ClaimOpenFile(string activationId, string appId)
    {
        ThrowIfDisposed();
        return _openFiles.ClaimForApplication(activationId, appId, _capabilityFactory);
    }

    public bool CancelOpenFile(string activationId)
    {
        ThrowIfDisposed();
        return _openFiles.Cancel(activationId);
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _shell.Dispose();
        lock (_gate)
        {
            _windowInitialized = false;
            _shortcutWarnings.Clear();
        }
    }

    private void ThrowIfDisposed()
    {
        if (_disposed) throw new ObjectDisposedException(nameof(DesktopShellIntegrationCoordinator));
    }

    internal sealed record HostShortcut(
        int Id,
        DesktopShellIntegrationBroker.ShortcutModifiers Modifiers,
        uint VirtualKey,
        string Action);

    internal sealed record ShortcutInitializationResult(bool Initialized, int RegisteredCount, string[] Warnings);
}
