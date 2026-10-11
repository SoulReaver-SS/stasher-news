import { LinkNode, AutoLinkNode, $createLinkNode, $createAutoLinkNode } from '@lexical/link'
import { privacyLinkElement } from '@/lib/privacy'

function originalExport (node, output) {
  const wrapper = output.element
  if (!wrapper.classList.contains('sn-private-link')) return output
  const element = wrapper.firstElementChild
  element.setAttribute('href', node.sanitizeUrl(node.getURL()))
  for (const attribute of ['dir', 'style', 'data-lexical-indent']) {
    if (wrapper.hasAttribute(attribute)) element.setAttribute(attribute, wrapper.getAttribute(attribute))
  }
  return { ...output, element }
}

// Replacements are reader-only. Legacy sn-* states remain readable in editors,
// but new JSON and HTML clipboard exports always use the original link format.
export class SNLinkNode extends LinkNode {
  static getType () { return 'sn-link' }
  static clone (node) {
    return new SNLinkNode(node.__url, { rel: node.__rel, target: node.__target, title: node.__title }, node.__key)
  }

  static importJSON (state) { return $createLinkNode().updateFromJSON(state) }
  static importDOM () { return LinkNode.importDOM() }

  createDOM (config) { return privacyLinkElement(super.createDOM(config), this.getURL()) }
  getDOMSlot (dom) {
    return super.getDOMSlot(dom.classList.contains('sn-private-link') ? dom.firstElementChild : dom)
  }

  updateDOM (prevNode, dom, config) {
    return prevNode.__url !== this.__url || super.updateDOM(prevNode, dom.classList.contains('sn-private-link') ? dom.firstElementChild : dom, config)
  }

  exportDOM (editor) {
    return originalExport(this, super.exportDOM(editor))
  }
}

export class SNAutoLinkNode extends AutoLinkNode {
  static getType () { return 'sn-autolink' }
  static clone (node) {
    return new SNAutoLinkNode(node.__url, {
      isUnlinked: node.__isUnlinked, rel: node.__rel, target: node.__target, title: node.__title
    }, node.__key)
  }

  static importJSON (state) { return $createAutoLinkNode().updateFromJSON(state) }
  static importDOM () { return AutoLinkNode.importDOM() }

  createDOM (config) { return privacyLinkElement(super.createDOM(config), this.getURL()) }
  getDOMSlot (dom) {
    return super.getDOMSlot(dom.classList.contains('sn-private-link') ? dom.firstElementChild : dom)
  }

  updateDOM (prevNode, dom, config) {
    return prevNode.__url !== this.__url || super.updateDOM(prevNode, dom.classList.contains('sn-private-link') ? dom.firstElementChild : dom, config)
  }

  exportDOM (editor) {
    return originalExport(this, super.exportDOM(editor))
  }
}

export const LINK_NODE_REPLACEMENT = {
  replace: LinkNode,
  with: node => new SNLinkNode(node.getURL(), { rel: node.getRel(), target: node.getTarget(), title: node.getTitle() }),
  withKlass: SNLinkNode
}

export const AUTOLINK_NODE_REPLACEMENT = {
  replace: AutoLinkNode,
  with: node => new SNAutoLinkNode(node.getURL(), {
    isUnlinked: node.getIsUnlinked(), rel: node.getRel(), target: node.getTarget(), title: node.getTitle()
  }),
  withKlass: SNAutoLinkNode
}
