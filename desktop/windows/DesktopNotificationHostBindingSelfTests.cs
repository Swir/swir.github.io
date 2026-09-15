using System.Text.Json;

namespace Swir.Desktop.Host;

internal static class DesktopNotificationHostBindingSelfTests
{
    private static int _passed;

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
        _passed++;
    }

    internal static int Main()
    {
        CreateBindsPermissionAndProvider();
        DispatchPreservesStableErrors();
        DispatchPreservesProviderPolicyErrors();
        DispatchRejectsUnsupportedMethod();
        Console.WriteLine($"Desktop notification host binding self-tests passed: {_passed}");
        return 0;
    }

    private static void CreateBindsPermissionAndProvider()
    {
        var permissions = new PermissionBroker();
        var tray = new DesktopTrayIcon();
        var bridge = DesktopNotificationHostBinding.Create(permissions, tray);
        using var doc = JsonDocument.Parse("[\"Title\",\"Message\",\" swir.chat \",true]");
        var result = bridge.Dispatch("show", doc.RootElement, "token-chat");

        Assert(permissions.Calls == 1, "Permission broker must be called exactly once.");
        Assert(permissions.Token == "token-chat", "Execution token must reach PermissionBroker.");
        Assert(permissions.Surface == "notifications" && permissions.Method == "show", "Binding must authorize notifications.show.");
        Assert(permissions.Owner == "swir.chat", "Normalized owner must be authorization target.");
        Assert(tray.Calls == 1 && tray.AppId == "swir.chat" && tray.Silent, "Authorized request must reach DesktopTrayIcon once.");
        Assert((string?)result == "delivered", "Provider result must be returned unchanged.");
    }

    private static void DispatchPreservesStableErrors()
    {
        var bridge = new DesktopNotificationBridgeService((_, _) => { }, (_, _, _, _) => "unused");
        using var doc = JsonDocument.Parse("[\"Title\",\"Message\",\"bad app id\"]");
        try
        {
            _ = DesktopNotificationHostBinding.Dispatch(bridge, "show", doc.RootElement, "token");
            throw new InvalidOperationException("Invalid app id should fail.");
        }
        catch (BridgeException ex)
        {
            Assert(ex.Code == "INVALID_APP_ID", "Binding must preserve INVALID_APP_ID for host bridge responses.");
        }
    }

    private static void DispatchPreservesProviderPolicyErrors()
    {
        foreach (var code in new[] { "NOTIFICATION_RATE_LIMITED", "NOTIFICATION_DUPLICATE" })
        {
            var bridge = new DesktopNotificationBridgeService(
                (_, _) => { },
                (_, _, _, _) => throw new NativeNotificationException(code, $"policy:{code}"));
            using var doc = JsonDocument.Parse("[\"Title\",\"Message\",\"swir.chat\"]");
            try
            {
                _ = DesktopNotificationHostBinding.Dispatch(bridge, "show", doc.RootElement, "token");
                throw new InvalidOperationException($"{code} should fail closed.");
            }
            catch (BridgeException ex)
            {
                Assert(ex.Code == code, $"Binding must preserve {code} for host bridge responses.");
                Assert(ex.Message == $"policy:{code}", $"Binding must preserve {code} diagnostic message.");
            }
        }
    }

    private static void DispatchRejectsUnsupportedMethod()
    {
        var bridge = new DesktopNotificationBridgeService((_, _) => { }, (_, _, _, _) => "unused");
        using var doc = JsonDocument.Parse("[]");
        try
        {
            _ = DesktopNotificationHostBinding.Dispatch(bridge, "remove", doc.RootElement, "token");
            throw new InvalidOperationException("Unsupported method should fail.");
        }
        catch (BridgeException ex)
        {
            Assert(ex.Code == "RUNTIME_UNSUPPORTED", "Binding must preserve RUNTIME_UNSUPPORTED.");
        }
    }
}

// Minimal test doubles intentionally match the production composition signatures.
internal sealed class PermissionBroker
{
    internal int Calls { get; private set; }
    internal string? Token { get; private set; }
    internal string? Surface { get; private set; }
    internal string? Method { get; private set; }
    internal string? Owner { get; private set; }

    internal void Authorize(string? token, string surface, string method, string? owner)
    {
        Calls++;
        Token = token;
        Surface = surface;
        Method = method;
        Owner = owner;
    }
}

internal sealed class DesktopTrayIcon
{
    internal int Calls { get; private set; }
    internal string? AppId { get; private set; }
    internal bool Silent { get; private set; }

    internal object ShowNotification(string title, string message, string appId, bool silent)
    {
        Calls++;
        AppId = appId;
        Silent = silent;
        return "delivered";
    }
}

internal sealed class BridgeException(string code, string message) : Exception(message)
{
    internal string Code { get; } = code;
}
