namespace Swir.Desktop.Host;

internal static class NativeNotificationPolicySelfTests
{
    private static int Main()
    {
        try
        {
            var now = new DateTimeOffset(2026, 9, 15, 9, 0, 0, TimeSpan.Zero);
            var policy = new NativeNotificationPolicy(() => now, maxPerWindow: 2, window: TimeSpan.FromMinutes(1), duplicateWindow: TimeSpan.FromSeconds(2));

            var prepared = policy.Prepare("  Hello\r\n ", "  Desktop\0 event  ", "swir.chat", true);
            Require(prepared.Title == "Hello", "title must be trimmed and control characters removed");
            Require(prepared.Message == "Desktop event", "message must be normalized");
            Require(prepared.AppId == "swir.chat" && prepared.Silent, "identity and silent intent must survive normalization");

            ExpectCode("NOTIFICATION_DUPLICATE", () => policy.Prepare("Hello", "Desktop event", "swir.chat", true));
            now = now.AddSeconds(3);
            _ = policy.Prepare("Hello", "Second", "swir.chat", false);
            ExpectCode("NOTIFICATION_RATE_LIMITED", () => policy.Prepare("Hello", "Third", "swir.chat", false));

            now = now.AddMinutes(1);
            _ = policy.Prepare("After window", "Allowed", "swir.chat", false);
            _ = policy.Prepare("Other app", "Independent quota", "swir.player", false);

            ExpectCode("INVALID_APP_ID", () => policy.Prepare("Bad", "Identity", "../escape", false));
            var fallback = policy.Prepare(null, null, null, false);
            Require(fallback.AppId == "swir.system", "missing identity must use the controlled system fallback");
            Require(fallback.Title == "SWIR OS" && fallback.Message == "Application event", "missing text must use controlled fallbacks");

            var longPolicy = new NativeNotificationPolicy(() => now);
            var bounded = longPolicy.Prepare(new string('T', 100), new string('M', 400), "swir.matrix", false);
            Require(bounded.Title.Length == 63 && bounded.Message.Length == 255, "native text must be bounded before provider delivery");

            Console.WriteLine("SWIR native notification policy self-tests: PASS");
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex);
            return 1;
        }
    }

    private static void ExpectCode(string code, Action action)
    {
        try { action(); }
        catch (NativeNotificationException ex) when (ex.Code == code) { return; }
        throw new InvalidOperationException($"Expected native notification error {code}.");
    }

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
