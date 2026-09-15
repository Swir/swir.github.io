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

    internal static object Describe() => new
    {
        schema = "swir.desktop-notification-host-binding/0.1",
        surface = "notifications",
        method = "show",
        permission = "notifications.show",
        ownerBound = true,
        provider = "DesktopTrayIcon",
        authorization = "PermissionBroker",
        failClosed = true
    };
}
