import { QuoteNode, HeadingNode } from '@lexical/rich-text'
import { TableCellNode, TableNode, TableRowNode } from '@lexical/table'
import { ListItemNode, ListNode } from '@lexical/list'
import { CodeHighlightNode, CodeNode } from '@lexical/code-core'
import { AutoLinkNode, LinkNode } from '@lexical/link'
import { HorizontalRuleNode } from '@lexical/extension'
import { MediaNode } from './content/media'
import { EmbedNode } from './content/embed'
import { MathNode } from './formatting/math'
import { TableOfContentsNode } from './content/toc'
import { SNHeadingNode, $createSNHeadingNode } from './misc/heading'
import {
  SNLinkNode,
  SNAutoLinkNode,
  LINK_NODE_REPLACEMENT,
  AUTOLINK_NODE_REPLACEMENT
} from './content/link'
import {
  UserMentionNode,
  TerritoryMentionNode,
  ItemMentionNode
} from './decorative/mentions'
import {
  FootnoteReferenceNode,
  FootnoteDefinitionNode,
  FootnotesSectionNode,
  FootnoteBackrefNode
} from './decorative/footnote'
import { GalleryNode } from './content/gallery'

const DefaultNodes = [
  SNHeadingNode,
  {
    replace: HeadingNode,
    with: (node) => $createSNHeadingNode(node.getTag()),
    withKlass: SNHeadingNode
  },
  ListNode,
  ListItemNode,
  QuoteNode,
  CodeNode,
  CodeHighlightNode,
  TableNode,
  TableCellNode,
  TableRowNode,
  SNAutoLinkNode,
  SNLinkNode,
  AutoLinkNode,
  LinkNode,
  HorizontalRuleNode,
  // custom SN nodes
  GalleryNode,
  MediaNode,
  UserMentionNode,
  TerritoryMentionNode,
  ItemMentionNode,
  FootnoteReferenceNode,
  FootnoteDefinitionNode,
  FootnotesSectionNode,
  FootnoteBackrefNode,
  MathNode,
  TableOfContentsNode,
  EmbedNode
]

export default DefaultNodes

export const ReaderNodes = [...DefaultNodes, LINK_NODE_REPLACEMENT, AUTOLINK_NODE_REPLACEMENT]
