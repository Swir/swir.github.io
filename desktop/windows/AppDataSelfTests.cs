using System.Text.Json;

namespace Swir.Desktop.Host.SelfTests;

internal static class AppDataSelfTests
{
    public static int Main()
    {
        var root = Path.Combine(Path.GetTempPath(), "swir-appdata-selftest-" + Guid.NewGuid().ToString("N"));
        try
        {
            Directory.CreateDirectory(root);
            var broker = new Swir.Desktop.Host.AppDataBroker(root);

            using var alphaValueDoc = JsonDocument.Parse("{\"owner\":\"alpha\",\"value\":42}");
            using var betaFallbackDoc = JsonDocument.Parse("\"missing\"");
            broker.Set("swir.alpha", "state", alphaValueDoc.RootElement);

            var alpha = JsonSerializer.Serialize(broker.Get("swir.alpha", "state", betaFallbackDoc.RootElement));
            Require(alpha.Contains("alpha", StringComparison.Ordinal), "alpha package could not read its own value");

            var beta = JsonSerializer.Serialize(broker.Get("swir.beta", "state", betaFallbackDoc.RootElement));
            Require(beta == "\"missing\"", "beta package observed alpha package data");
            Require(broker.List("swir.beta").Length == 0, "beta package listing leaked alpha data");

            ExpectCode("APP_DATA_INVALID_KEY", () => broker.Set("swir.alpha", "../escape", alphaValueDoc.RootElement));
            ExpectCode("INVALID_APP_ID", () => broker.Set("../escape", "state", alphaValueDoc.RootElement));

            var corruptDir = Path.Combine(root, "swir.alpha", "Data");
            Directory.CreateDirectory(corruptDir);
            File.WriteAllText(Path.Combine(corruptDir, "corrupt.json"), "{broken-json");
            ExpectCode("APP_DATA_CORRUPT", () => broker.Get("swir.alpha", "corrupt", betaFallbackDoc.RootElement));

            var quotaDir = Path.Combine(root, "swir.quota", "Data");
            Directory.CreateDirectory(quotaDir);
            for (var i = 0; i < 16; i++)
                File.WriteAllBytes(Path.Combine(quotaDir, $"seed-{i:D2}.json"), new byte[1024 * 1024]);
            using var tinyDoc = JsonDocument.Parse("1");
            ExpectCode("APP_DATA_QUOTA_EXCEEDED", () => broker.Set("swir.quota", "overflow", tinyDoc.RootElement));

            var itemDir = Path.Combine(root, "swir.items", "Data");
            Directory.CreateDirectory(itemDir);
            for (var i = 0; i < Swir.Desktop.Host.AppDataBroker.MaxItems; i++)
                File.WriteAllText(Path.Combine(itemDir, $"item-{i:D3}.json"), "0");
            ExpectCode("APP_DATA_ITEM_LIMIT", () => broker.Set("swir.items", "overflow", tinyDoc.RootElement));

            Console.WriteLine("SWIR App Data self-tests: PASS");
            Console.WriteLine("- package isolation");
            Console.WriteLine("- path/key validation");
            Console.WriteLine("- corrupt JSON handling");
            Console.WriteLine("- 16 MiB package quota");
            Console.WriteLine("- 512 item limit");
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("SWIR App Data self-tests: FAIL");
            Console.Error.WriteLine(ex);
            return 1;
        }
        finally
        {
            try { if (Directory.Exists(root)) Directory.Delete(root, true); } catch { }
        }
    }

    private static void ExpectCode(string code, Action action)
    {
        try
        {
            action();
            throw new InvalidOperationException($"Expected BridgeException {code} was not thrown.");
        }
        catch (Swir.Desktop.Host.BridgeException ex) when (ex.Code == code)
        {
        }
    }

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
