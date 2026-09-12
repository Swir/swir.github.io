using System.Text;

namespace Swir.Desktop.Host;

internal static class NativeFileSystemBrokerSelfTests
{
    private static int Main()
    {
        var root = Path.Combine(Path.GetTempPath(), "swir-native-fs-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var broker = new NativeFileSystemBroker(root, maxFileBytes: 1024, maxFiles: 3);

            var saved = broker.Save("hello.txt", "hello SWIR");
            Assert(saved.Name == "hello.txt", "save returns canonical name");
            Assert(saved.Size == Encoding.UTF8.GetByteCount("hello SWIR"), "save returns byte size");
            Assert(saved.Sha256.Length == 64, "save returns sha256");

            var loaded = broker.Get("hello.txt") ?? throw new Exception("saved file was not readable");
            Assert(loaded.Content == "hello SWIR", "get returns stored content");
            Assert(loaded.Sha256 == saved.Sha256, "get hash matches save hash");

            broker.Save("hello.txt", "updated");
            Assert(broker.Get("hello.txt")?.Content == "updated", "overwrite is atomic and visible");
            Assert(!Directory.EnumerateFiles(root).Any(path => path.EndsWith(".tmp", StringComparison.OrdinalIgnoreCase)), "temporary writes are cleaned");

            broker.Save("b.txt", "b");
            broker.Save("c.txt", "c");
            Assert(broker.List().Length == 3, "list returns sandbox files");
            ExpectCode("FILESYSTEM_QUOTA", () => broker.Save("d.txt", "d"));

            ExpectCode("INVALID_PATH", () => broker.Get("../escape.txt"));
            ExpectCode("INVALID_PATH", () => broker.Save("sub/file.txt", "bad"));
            ExpectCode("RESOURCE_TOO_LARGE", () => broker.Save("hello.txt", new string('x', 2048)));

            Assert(broker.Remove("b.txt"), "remove deletes existing file");
            Assert(!broker.Remove("missing.txt"), "remove is false for missing file");

            var descriptor = broker.Describe().ToString();
            Assert(descriptor is not null, "describe returns contract metadata");

            Console.WriteLine("NATIVE_FILESYSTEM_SELF_TESTS_OK");
            return 0;
        }
        finally
        {
            try { Directory.Delete(root, recursive: true); } catch { }
        }
    }

    private static void ExpectCode(string code, Action action)
    {
        try
        {
            action();
            throw new Exception($"Expected NativeFileSystemException {code}.");
        }
        catch (NativeFileSystemException ex) when (ex.Code == code)
        {
        }
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new Exception("Assertion failed: " + message);
    }
}
