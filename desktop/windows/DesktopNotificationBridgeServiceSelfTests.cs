namespace Swir.Desktop.Host;

internal static class DesktopNotificationBridgeServiceSelfTests
{
    private static int Main()
    {
        var authorized = new List<(string? Token, string Owner)>();
        var delivered = new List<(string Title, string Message, string AppId, bool Silent)>();
        var service = new DesktopNotificationBridgeService(
            (token, owner) => authorized.Add((token, owner)),
            (title, message, appId, silent) =>
            {
                delivered.Add((title, message, appId, silent));
                return new { delivered = true, appId };
            });

        _ = service.Show("exec_test", "Build complete", "Ready", " swir.chat ", true);
        Assert(authorized.Count == 1, "authorization must execute exactly once");
        Assert(authorized[0] == ("exec_test", "swir.chat"), "authorization must bind the normalized owner identity");
        Assert(delivered.Count == 1, "provider must execute after authorization");
        Assert(delivered[0] == ("Build complete", "Ready", "swir.chat", true), "provider must receive normalized request");

        var deniedDeliveries = 0;
        var denied = new DesktopNotificationBridgeService(
            (_, _) => throw new InvalidOperationException("PERMISSION_DENIED"),
            (_, _, _, _) => { deniedDeliveries++; return new object(); });
        AssertThrows<InvalidOperationException>(() => denied.Show("exec_denied", "x", "y", "swir.code"), "authorization denial must fail closed");
        Assert(deniedDeliveries == 0, "provider must never run after authorization denial");

        var invalidAuthorizations = 0;
        var invalid = new DesktopNotificationBridgeService(
            (_, _) => invalidAuthorizations++,
            (_, _, _, _) => new object());
        AssertThrows<ArgumentException>(() => invalid.Show("exec_test", "x", "y", "../shell"), "invalid owner identity must fail before authorization");
        AssertThrows<ArgumentException>(() => invalid.Show("exec_test", "x", "y", ""), "empty owner identity must fail before authorization");
        Assert(invalidAuthorizations == 0, "invalid identity must not reach permission broker");

        var description = service.Describe().ToString() ?? string.Empty;
        Assert(description.Contains("swir.desktop-notification-bridge/0.1", StringComparison.Ordinal), "bridge must expose a versioned contract");

        Console.WriteLine("Desktop notification bridge service self-tests passed.");
        return 0;
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }

    private static void AssertThrows<T>(Action action, string message) where T : Exception
    {
        try { action(); }
        catch (T) { return; }
        throw new InvalidOperationException(message);
    }
}
