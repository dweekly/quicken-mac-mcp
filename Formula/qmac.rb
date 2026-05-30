class Qmac < Formula
  desc "Self-documenting CLI and MCP server for Quicken For Mac"
  homepage "https://dweekly.github.io/quicken-mac-mcp/"
  url "https://registry.npmjs.org/quicken-mac-mcp/-/quicken-mac-mcp-1.4.0.tgz"
  sha256 "e2620c19c55ed2cf9c3caff263185e9c4e86138a397398679eeb0c1beae6fb24"
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
