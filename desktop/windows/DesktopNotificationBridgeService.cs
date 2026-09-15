using System.Text.Json;

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

    internal object Dispatch(string method, JsonElement args, string? executionToken)
    {
        if (!string.Equals(method, "show", StringComparison.Ordinal))
            throw new DesktopNotificationBridgeException("RUNTIME_UNSUPPORTED", $"Unsupported notifications method: {method}");

        if (args.ValueKind != JsonValueKind.Array || args.GetArrayLength() < 3 || args.GetArrayLength() > 4)
            throw new DesktopNotificationBridgeException("INVALID_ARGUMENT", "notifications.show requires title, message, appId and optional silent arguments.");

        var title = RequireString(args, 0, "title");
        var message = RequireString(args, 1, "message");
        var appId = RequireString(args, 2, "appId");
        var silent = false;
        if (args.GetArrayLength() == 4)
        {
            if (args[3].ValueKind is not JsonValueKind.True and not JsonValueKind.False)
                throw new DesktopNotificationBridgeException("INVALID_ARGUMENT", "notifications.show silent must be a boolean.");
            silent = args[3].GetBoolean();
        }

        return Show(executionToken, title, message, appId, silent);
    }

    internal object Show(string? executionToken, string title, string message, string appId, bool silent = false)
    {
        var owner = NormalizeAppId(appId);
        _authorize(executionToken, owner);
        return _deliver(title ?? string.Empty, message ?? string.Empty, owner, silent);
    }

    internal object Describe() => new
    {
        schema = "swir.desktop-notification-bridge/0.2",
        surface = "notifications",
        methods = new[] { "show" },
        permission = "notifications.show",
        ownerBound = true,
        hostOwnedProvider = true,
        strictArguments = true,
        providerCalledAfterAuthorization = true
    };

    private static string RequireString(JsonElement args, int index, string name)
    {
        if (args[index].ValueKind != JsonValueKind.String)
            throw new DesktopNotificationBridgeException("INVALID_ARGUMENT", $"notifications.show {name} must be a string.");
        return args[index].GetString() ?? string.Empty;
    }

    private static string NormalizeAppId(string appId)
    {
        var value = (appId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(value))
            throw new DesktopNotificationBridgeException("INVALID_APP_ID", "Application identity is required for native notifications.");
        if (value.Length > 128 || value.Any(ch => !(char.IsLetterOrDigit(ch) || ch is '.' or '-' or '_')))
            throw new DesktopNotificationBridgeException("INVALID_APP_ID", "Application identity contains unsupported characters.");
        return value;
    }
}

internal sealed class DesktopNotificationBridgeException(string code, string message) : Exception(message)
{
    internal string Code { get; } = code;
}
