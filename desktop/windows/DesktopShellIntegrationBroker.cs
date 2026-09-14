using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace Swir.Desktop.Host;

internal sealed class DesktopShellIntegrationBroker : IDisposable
{
    private const string Schema = "swir.desktop-shell-integration/0.1";
    private readonly Dictionary<int, ShortcutRegistration> _shortcuts = new();
    private readonly object _gate = new();
    private bool _disposed;

    public object Describe() => new
    {
        schema = Schema,
        platform = "windows",
        shortcutProvider = "RegisterHotKey",
        associationProvider = "HKCU\\Software\\Classes",
        machineWideWrites = false,
        changesDefaultApplicationWithoutUserChoice = false,
        windowsUserChoiceProtected = true,
        registeredShortcutCount = _shortcuts.Count,
        supportedAssociationScope = "current-user",
        safeAssociationExtensions = new[] { ".txt", ".md", ".log", ".json", ".swirapp" }
    };

    public ShortcutRegistration RegisterShortcut(IntPtr windowHandle, int id, ShortcutModifiers modifiers, uint virtualKey, string action)
    {
        ThrowIfDisposed();
        if (windowHandle == IntPtr.Zero) throw new ArgumentException("A valid Desktop Host window handle is required.", nameof(windowHandle));
        if (id <= 0) throw new ArgumentOutOfRangeException(nameof(id));
        if (virtualKey == 0) throw new ArgumentOutOfRangeException(nameof(virtualKey));
        if (string.IsNullOrWhiteSpace(action)) throw new ArgumentException("Shortcut action is required.", nameof(action));

        lock (_gate)
        {
            if (_shortcuts.ContainsKey(id)) throw new InvalidOperationException($"Shortcut id {id} is already registered.");
            if (!RegisterHotKey(windowHandle, id, (uint)modifiers | ModifierNoRepeat, virtualKey))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Windows rejected the global shortcut registration.");
            var registration = new ShortcutRegistration(windowHandle, id, modifiers, virtualKey, action.Trim());
            _shortcuts[id] = registration;
            return registration;
        }
    }

    public bool TryResolveShortcut(int id, out string? action)
    {
        lock (_gate)
        {
            if (_shortcuts.TryGetValue(id, out var registration))
            {
                action = registration.Action;
                return true;
            }
        }
        action = null;
        return false;
    }

    public bool UnregisterShortcut(IntPtr windowHandle, int id)
    {
        ThrowIfDisposed();
        lock (_gate)
        {
            if (!_shortcuts.Remove(id, out var registration)) return false;
            var owner = windowHandle != IntPtr.Zero ? windowHandle : registration.WindowHandle;
            if (owner != IntPtr.Zero) _ = UnregisterHotKey(owner, id);
            return true;
        }
    }

    public AssociationPlan PlanAssociation(string extension, string executablePath)
    {
        ThrowIfDisposed();
        var normalized = NormalizeExtension(extension);
        var executable = Path.GetFullPath(executablePath ?? throw new ArgumentNullException(nameof(executablePath)));
        if (!File.Exists(executable)) throw new FileNotFoundException("Association executable does not exist.", executable);

        var progId = "SWIR.OS" + normalized.Replace(".", "_", StringComparison.Ordinal).ToUpperInvariant();
        var command = $"\"{executable}\" --open-file \"%1\"";
        return new AssociationPlan(normalized, progId, command, "current-user", false);
    }

    public AssociationResult RegisterCurrentUserAssociation(AssociationPlan plan)
    {
        ThrowIfDisposed();
        ArgumentNullException.ThrowIfNull(plan);
        var normalized = NormalizeExtension(plan.Extension);
        if (!string.Equals(normalized, plan.Extension, StringComparison.Ordinal))
            throw new InvalidOperationException("Association plan extension is not normalized.");
        if (!string.Equals(plan.Scope, "current-user", StringComparison.Ordinal) || plan.MachineWide)
            throw new InvalidOperationException("Only current-user associations are supported.");
        if (!plan.ProgId.StartsWith("SWIR.OS", StringComparison.Ordinal))
            throw new InvalidOperationException("Only SWIR-owned ProgIDs may be registered.");

        using var classes = Registry.CurrentUser.CreateSubKey("Software\\Classes", writable: true)
            ?? throw new InvalidOperationException("Unable to open current-user Classes registry hive.");
        using (var progId = classes.CreateSubKey(plan.ProgId, writable: true))
        {
            progId?.SetValue(string.Empty, $"SWIR OS {normalized} file", RegistryValueKind.String);
            using var command = progId?.CreateSubKey("shell\\open\\command", writable: true);
            command?.SetValue(string.Empty, plan.OpenCommand, RegistryValueKind.String);
        }
        using (var extension = classes.CreateSubKey(normalized + "\\OpenWithProgids", writable: true))
            extension?.SetValue(plan.ProgId, Array.Empty<byte>(), RegistryValueKind.Binary);

        return new AssociationResult(normalized, plan.ProgId, true, false, "Windows keeps default-app UserChoice under user control; SWIR only registers itself as an available handler.");
    }

    public AssociationResult RemoveCurrentUserAssociation(string extension)
    {
        ThrowIfDisposed();
        var normalized = NormalizeExtension(extension);
        var progId = "SWIR.OS" + normalized.Replace(".", "_", StringComparison.Ordinal).ToUpperInvariant();
        using var classes = Registry.CurrentUser.OpenSubKey("Software\\Classes", writable: true);
        if (classes is null) return new AssociationResult(normalized, progId, false, false, "No current-user Classes hive was available.");
        try { classes.DeleteSubKeyTree(progId, throwOnMissingSubKey: false); } catch (ArgumentException) { }
        using var openWith = classes.OpenSubKey(normalized + "\\OpenWithProgids", writable: true);
        try { openWith?.DeleteValue(progId, throwOnMissingValue: false); } catch (ArgumentException) { }
        return new AssociationResult(normalized, progId, false, false, "SWIR handler registration removed; Windows UserChoice was not modified.");
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        lock (_gate)
        {
            foreach (var registration in _shortcuts.Values)
            {
                if (registration.WindowHandle != IntPtr.Zero)
                    _ = UnregisterHotKey(registration.WindowHandle, registration.Id);
            }
            _shortcuts.Clear();
        }
    }

    private static string NormalizeExtension(string extension)
    {
        if (string.IsNullOrWhiteSpace(extension)) throw new ArgumentException("File extension is required.", nameof(extension));
        var value = extension.Trim().ToLowerInvariant();
        if (!value.StartsWith('.')) value = "." + value;
        if (value.Length is < 2 or > 17 || value.Skip(1).Any(ch => !char.IsLetterOrDigit(ch)))
            throw new ArgumentException("File extension contains unsupported characters.", nameof(extension));
        return value;
    }

    private void ThrowIfDisposed()
    {
        if (_disposed) throw new ObjectDisposedException(nameof(DesktopShellIntegrationBroker));
    }

    private const uint ModifierNoRepeat = 0x4000;

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    [Flags]
    internal enum ShortcutModifiers : uint
    {
        Alt = 0x0001,
        Control = 0x0002,
        Shift = 0x0004,
        Windows = 0x0008
    }

    internal sealed record ShortcutRegistration(IntPtr WindowHandle, int Id, ShortcutModifiers Modifiers, uint VirtualKey, string Action);
    internal sealed record AssociationPlan(string Extension, string ProgId, string OpenCommand, string Scope, bool MachineWide);
    internal sealed record AssociationResult(string Extension, string ProgId, bool Registered, bool DefaultChanged, string Note);
}
