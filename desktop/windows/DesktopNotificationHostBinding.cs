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
    /// Shipping-host dispatch boundary. Notification-specific validation and provider
    /// policy errors are translated into the host's stable BridgeException contract here
    /// so Program.cs never needs provider internals and cannot collapse abuse-control
    /// results such as NOTIFICATION_RATE_LIMITED / NOTIFICATION_DUPLICATE into a generic
    /// NATIVE_HOST_ERROR.
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
        catch (NativeNotificationException ex)
        {
            throw new BridgeException(ex.Code, ex.Message);
        }
    }

    internal static object Describe() => new
    {
        schema = "swir.desktop-notification-host-binding/0.3",
        surface = "notifications",
        methods = new[] { "show" },
        permission = "notifications.show",
        ownerBound = true,
        provider = "DesktopTrayIcon",
        authorization = "PermissionBroker",
        strictArguments = true,
        stableBridgeErrors = true,
        providerPolicyErrors = new[] { "INVALID_APP_ID", "NOTIFICATION_RATE_LIMITED", "NOTIFICATION_DUPLICATE" },
        failClosed = true
    };
}
