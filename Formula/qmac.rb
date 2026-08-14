class Qmac < Formula
  desc "Self-documenting CLI and MCP server for Quicken For Mac"
  homepage "https://dweekly.github.io/quicken-mac-mcp/"
  url "https://registry.npmjs.org/quicken-mac-mcp/-/quicken-mac-mcp-1.6.0.tgz"
  sha256 "24691c818138b5304ec7c5346e972f1fb6dd07c568486a4d976289bb4b220041"
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
