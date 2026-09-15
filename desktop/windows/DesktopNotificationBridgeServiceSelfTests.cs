using System.Text.Json;

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

        using (var dispatchArgs = JsonDocument.Parse("[\"Native title\",\"Native body\",\" swir.chat \",true]"))
            _ = service.Dispatch("show", dispatchArgs.RootElement, "exec_dispatch");
        Assert(authorized[^1] == ("exec_dispatch", "swir.chat"), "dispatch must authorize normalized owner identity");
        Assert(delivered[^1] == ("Native title", "Native body", "swir.chat", true), "dispatch must preserve validated notification arguments");

        using (var defaultSilentArgs = JsonDocument.Parse("[\"Title\",\"Body\",\"swir.chat\"]"))
            _ = service.Dispatch("show", defaultSilentArgs.RootElement, "exec_default_silent");
        Assert(delivered[^1].Silent == false, "silent must default to false when omitted");

        var deniedDeliveries = 0;
        var denied = new DesktopNotificationBridgeService(
            (_, _) => throw new InvalidOperationException("PERMISSION_DENIED"),
            (_, _, _, _) => { deniedDeliveries++; return new object(); });
        AssertThrows<InvalidOperationException>(() => denied.Show("exec_denied", "x", "y", "swir.code"), "authorization denial must fail closed");
        Assert(deniedDeliveries == 0, "provider must never run after authorization denial");

        var invalidAuthorizations = 0;
        var invalidDeliveries = 0;
        var invalid = new DesktopNotificationBridgeService(
            (_, _) => invalidAuthorizations++,
            (_, _, _, _) => { invalidDeliveries++; return new object(); });
        AssertBridgeError("INVALID_APP_ID", () => invalid.Show("exec_test", "x", "y", "../shell"), "invalid owner identity must fail before authorization");
        AssertBridgeError("INVALID_APP_ID", () => invalid.Show("exec_test", "x", "y", ""), "empty owner identity must fail before authorization");

        AssertDispatchError(invalid, "RUNTIME_UNSUPPORTED", "noop", "[]", "unknown notification methods must fail closed");
        AssertDispatchError(invalid, "INVALID_ARGUMENT", "show", "[]", "missing notification arguments must fail closed");
        AssertDispatchError(invalid, "INVALID_ARGUMENT", "show", "[\"a\",\"b\",\"swir.chat\",false,\"extra\"]", "extra notification arguments must fail closed");
        AssertDispatchError(invalid, "INVALID_ARGUMENT", "show", "[1,\"b\",\"swir.chat\"]", "title must be a string");
        AssertDispatchError(invalid, "INVALID_ARGUMENT", "show", "[\"a\",2,\"swir.chat\"]", "message must be a string");
        AssertDispatchError(invalid, "INVALID_ARGUMENT", "show", "[\"a\",\"b\",3]", "appId must be a string");
        AssertDispatchError(invalid, "INVALID_ARGUMENT", "show", "[\"a\",\"b\",\"swir.chat\",\"false\"]", "silent must be a boolean");
        Assert(invalidAuthorizations == 0, "invalid dispatch input must not reach permission broker");
        Assert(invalidDeliveries == 0, "invalid dispatch input must not reach notification provider");

        var description = service.Describe().ToString() ?? string.Empty;
        Assert(description.Contains("swir.desktop-notification-bridge/0.2", StringComparison.Ordinal), "bridge must expose the hardened versioned contract");

        Console.WriteLine("Desktop notification bridge service self-tests passed.");
        return 0;
    }

    private static void AssertDispatchError(DesktopNotificationBridgeService service, string code, string method, string json, string message)
    {
        using var document = JsonDocument.Parse(json);
        AssertBridgeError(code, () => service.Dispatch(method, document.RootElement, "exec_invalid"), message);
    }

    private static void AssertBridgeError(string code, Action action, string message)
    {
        try { action(); }
        catch (DesktopNotificationBridgeException ex) when (string.Equals(ex.Code, code, StringComparison.Ordinal)) { return; }
        throw new InvalidOperationException(message);
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
