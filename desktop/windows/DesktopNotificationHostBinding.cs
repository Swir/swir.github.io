using System.Text.Json;

namespace Swir.Desktop.Host;

/// <summary>
/// Single production composition point for native notifications. Keeping this binding
/// outside Program.cs makes the permission/provider boundary reusable by the shipping
/// host and independently reviewable.
/// </summary>
internal static class DesktopNotificationHostBinding
{
    internal static DesktopNotificationBridgeService Create(
        PermissionBroker permissions,
        DesktopTrayIcon tray)
    {
        ArgumentNullException.ThrowIfNull(permissions);
        ArgumentNullException.ThrowIfNull(tray);

        return new DesktopNotificationBridgeService(
            (executionToken, owner) => permissions.Authorize(
                executionToken,
                "notifications",
                "show",
                owner),
            (title, message, appId, silent) => tray.ShowNotification(
                title,
                message,
                appId,
                silent));
    }

    /// <summary>
    /// Shipping-host dispatch boundary. Notification-specific validation errors are
    /// translated into the host's stable BridgeException contract here so Program.cs
    /// never needs to know provider exception details and cannot accidentally collapse
    /// INVALID_ARGUMENT / INVALID_APP_ID into NATIVE_HOST_ERROR.
    /// </summary>
    internal static object Dispatch(
        DesktopNotificationBridgeService bridge,
        string method,
        JsonElement args,
        string? executionToken)
    {
        ArgumentNullException.ThrowIfNull(bridge);
        try
        {
            return bridge.Dispatch(method, args, executionToken);
        }
        catch (DesktopNotificationBridgeException ex)
        {
            throw new BridgeException(ex.Code, ex.Message);
        }
    }

    internal static object Describe() => new
    {
        schema = "swir.desktop-notification-host-binding/0.2",
        surface = "notifications",
        methods = new[] { "show" },
        permission = "notifications.show",
        ownerBound = true,
        provider = "DesktopTrayIcon",
        authorization = "PermissionBroker",
        strictArguments = true,
        stableBridgeErrors = true,
        failClosed = true
    };
}
