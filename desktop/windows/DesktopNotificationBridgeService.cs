namespace Swir.Desktop.Host;

/// <summary>
/// Portable host-owned boundary between the SWIR native bridge and the platform
/// notification provider. Authorization is deliberately injected so the shipping
/// host can bind it to PermissionBroker without exposing provider internals to web content.
/// </summary>
internal sealed class DesktopNotificationBridgeService
{
    private readonly Action<string?, string> _authorize;
    private readonly Func<string, string, string, bool, object> _deliver;

    internal DesktopNotificationBridgeService(
        Action<string?, string> authorize,
        Func<string, string, string, bool, object> deliver)
    {
        _authorize = authorize ?? throw new ArgumentNullException(nameof(authorize));
        _deliver = deliver ?? throw new ArgumentNullException(nameof(deliver));
    }

    internal object Show(string? executionToken, string title, string message, string appId, bool silent = false)
    {
        var owner = NormalizeAppId(appId);
        _authorize(executionToken, owner);
        return _deliver(title ?? string.Empty, message ?? string.Empty, owner, silent);
    }

    internal object Describe() => new
    {
        schema = "swir.desktop-notification-bridge/0.1",
        surface = "notifications",
        methods = new[] { "show" },
        permission = "notifications.show",
        ownerBound = true,
        hostOwnedProvider = true
    };

    private static string NormalizeAppId(string appId)
    {
        var value = (appId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(value))
            throw new ArgumentException("Application identity is required for native notifications.", nameof(appId));
        if (value.Length > 128 || value.Any(ch => !(char.IsLetterOrDigit(ch) || ch is '.' or '-' or '_')))
            throw new ArgumentException("Application identity contains unsupported characters.", nameof(appId));
        return value;
    }
}
