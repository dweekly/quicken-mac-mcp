class Qmac < Formula
  desc "Self-documenting CLI and MCP server for Quicken For Mac"
  homepage "https://dweekly.github.io/quicken-mac-mcp/"
  url "https://registry.npmjs.org/quicken-mac-mcp/-/quicken-mac-mcp-1.7.0.tgz"
  sha256 "143b4ed0a81ad5051daff6de09b642d15cd0ee6e736a22f8717ff9b7664addd2"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    # Simple sanity check
    system "#{bin}/qmac", "--version"
    system "#{bin}/quicken-mac-mcp", "--version"
  end
end
